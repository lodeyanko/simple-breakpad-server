import config, { getUploadPath } from './config';
import moment from 'moment';
import bodyParser from 'body-parser';
import methodOverride from 'method-override';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import { create as createHandlebars } from 'express-handlebars';
// @ts-ignore
import hbsPaginate from 'handlebars-paginate';
import * as paginate from 'express-paginate';
import Crashreport from './model/crashreport';
import Symfile from './model/symfile';
import db from './model/db';
import { titleCase } from 'title-case';
import busboy from 'connect-busboy';
import streamToArray from 'stream-to-array';
import { Sequelize, DataTypes } from 'sequelize';
// @ts-ignore
import addr from 'addr';
import * as fs from 'fs-extra';
// @ts-ignore
import expressDecompress from 'express-decompress';

const crashreportToApiJson = (crashreport: any) => {
  const json = crashreport.toJSON();

  for (const k in json) {
    if (Buffer.isBuffer(json[k])) {
      json[k] = `/crashreports/${json.id}/files/${k}`;
    }
  }

  return json;
};

const crashreportToViewJson = (exclude_hidden: boolean, report: any) => {
  let hidden = ['id', 'updatedAt'];
  if (exclude_hidden) {
    hidden = hidden.concat(config.get('customFields:hide'));
  }
  const fields: any = {
    id: report.id,
    props: {}
  };

  const json = report.toJSON();
  for (const k in json) {
    const v = json[k];
    if (hidden.includes(k)) {
      // pass
    } else if (config.get(`customFields:filesById:${k}`)) {
      // a file
      fields.props[k] = { path: `/crashreports/${report.id}/files/${k}` };
    } else if (Buffer.isBuffer(json[k])) {
      // shouldn't happen, should hit line above
    } else if (k === 'createdAt') {
      // change the name of this key for display purposes
      fields.props['created'] = moment(v).fromNow();
    } else if (v instanceof Date) {
      fields.props[k] = moment(v).fromNow();
    } else {
      fields.props[k] = (v != null) ? v : 'not present';
    }
  }

  if (!fields.props.upload_file_minidump) {
    fields.props.upload_file_minidump = { path: `/crashreports/${report.id}/files/upload_file_minidump` };
  }

  return fields;
};

const symfileToViewJson = (symfile: any, contents?: string) => {
  const hidden = ['id', 'updatedAt', 'contents'];
  const fields: any = {
    id: symfile.id,
    contents: contents,
    props: {}
  };

  const json = symfile.toJSON();

  for (const k in json) {
    const v = json[k];
    if (hidden.includes(k)) {
      // pass
    } else if (k === 'createdAt') {
      // change the name of this key for display purposes
      fields.props['created'] = moment(v).fromNow();
    } else if (v instanceof Date) {
      fields.props[k] = moment(v).fromNow();
    } else {
      fields.props[k] = (v != null) ? v : 'not present';
    }
  }

  return fields;
};

// initialization: init db and write all symfiles to disk
db.sync()
  .then(() => {
    return Symfile.findAll().then((symfiles) => {
      const pruneSymfilesFromDB = !config.get('filesInDatabase');
      // TODO: This is really, really slow when you have a lot of symfiles, and
      //   config.get('filesInDatabase') is true - only write those which do not
      //   already exist on disk?  User can delete the on-disk cache if needed.
      return Promise.all(symfiles.map((s) => Symfile.saveToDisk(s, pruneSymfilesFromDB)));
    });
  })
  .then(() => {
    console.log('Symfile loading finished');
    // @ts-ignore
    if (Symfile.didPrune) {
      // One-time vacuum of sqllite data to free up all of the data that was just deleted
      console.log('One-time compacting and syncing database after prune...');
      return db.query('VACUUM').then(() => {
        return db.sync().then(() => {
          console.log('Database compaction finished');
        });
      });
    } else {
      return;
    }
  })
  .then(() => {
    run();
  })
  .catch((err) => {
    console.error(err.stack);
    process.exit(1);
  });

const run = () => {
  const app = express();
  const breakpad = express();

  const hbs = createHandlebars({
    defaultLayout: 'main',
    partialsDir: path.resolve(__dirname, '..', 'views'),
    layoutsDir: path.resolve(__dirname, '..', 'views', 'layouts'),
    helpers: {
      paginate: hbsPaginate,
      reportUrl: (id: any) => `/crashreports/${id}`,
      symfileUrl: (id: any) => `/symfiles/${id}`,
      titleCase: titleCase
    }
  });

  breakpad.use(expressDecompress.create());
  breakpad.set('json spaces', 2);
  breakpad.set('views', path.resolve(__dirname, '..', 'views'));
  breakpad.engine('handlebars', hbs.engine);
  breakpad.set('view engine', 'handlebars');
  breakpad.use(bodyParser.json());
  breakpad.use(bodyParser.urlencoded({ extended: true }));
  breakpad.use(methodOverride());

  const baseUrl = config.get('baseUrl');
  const port = config.get('port');

  app.use(baseUrl, breakpad);

  const bsStatic = path.resolve(__dirname, '..', 'node_modules/bootstrap/dist');
  breakpad.use('/assets', express.static(bsStatic));

  // error handler
  breakpad.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (err.message == null) {
      console.log('warning: error thrown without a message');
    }

    if (err.stack) {
      console.error(err);
    } else {
      console.trace(err);
    }
    res.status(500).send(`Bad things happened:<br/> ${err.message || err}`);
  });

  breakpad.use(busboy({
    limits: {
      fileSize: config.get('fileMaxUploadSize')
    }
  }));

  let lastReportId = 0;
  breakpad.post('/crashreports', (req: Request, res: Response, next: NextFunction) => {
    const props: any = {};
    const streamOps: Promise<any>[] = [];
    // Get originating request address, respecting reverse proxies (e.g.
    //   X-Forwarded-For header)
    // Fixed list of just localhost as trusted reverse-proxy, we can add
    //   a config option if needed
    props.ip = addr(req, ['127.0.0.1', '::ffff:127.0.0.1']);
    const reportUploadGuid = moment().format('YYYY-MM-DD.HH.mm.ss') + '.' +
      process.pid + '.' + (++lastReportId);

    const busboyInstance = (req as any).busboy;

    busboyInstance.on('file', (fieldname: string, file: any, filename: string, encoding: string, mimetype: string) => {
      if (config.get('filesInDatabase')) {
        streamOps.push(streamToArray(file).then((parts: any[]) => {
          const buffers: Buffer[] = [];
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            buffers.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
          }
          return Buffer.concat(buffers);
        }).then((buffer) => {
          if (fieldname in Crashreport.rawAttributes) {
            props[fieldname] = buffer;
          }
        }));
      } else {
        // Stream file to disk, record filename in database
        if (fieldname in Crashreport.rawAttributes) {
          let saveFilename = path.join(reportUploadGuid, fieldname);
          props[fieldname] = saveFilename;
          saveFilename = path.join(getUploadPath(), saveFilename);
          
          // fs.mkdirs returns promise in fs-extra
          streamOps.push(fs.mkdirs(path.dirname(saveFilename)).then(() => {
            file.pipe(fs.createWriteStream(saveFilename));
            return new Promise((resolve, reject) => {
               file.on('end', resolve);
               file.on('error', reject);
            });
          }));
        } else {
          file.resume(); // consume the stream
        }
      }
    });

    const extraFields: any = {};
    busboyInstance.on('field', (fieldname: string, val: any, fieldnameTruncated: boolean, valTruncated: boolean) => {
      if (fieldname === 'prod') {
        props['product'] = val;
      } else if (fieldname === 'ver') {
        props['version'] = val;
      } else if (fieldname in Crashreport.rawAttributes) {
        props[fieldname] = val.toString();
      } else if (config.get('extraField')) {
        extraFields[fieldname] = val.toString();
        props[config.get('extraField')] = JSON.stringify(extraFields);
      }
    });

    busboyInstance.on('finish', () => {
      Promise.all(streamOps).then(() => {
        return Crashreport.create(props).then((report) => {
          res.json(crashreportToApiJson(report));
        });
      }).catch((err) => {
        next(err);
      });
    });

    req.pipe(busboyInstance);
  });

  breakpad.get('/', (req, res, next) => {
    res.redirect('/crashreports');
  });

  breakpad.use(paginate.middleware(10, 50));
  breakpad.get('/crashreports', (req: Request, res: Response, next: NextFunction) => {
    const limit = (req.query.limit as any) || 10;
    const offset = (req as any).offset || 0;
    const page = (req.query.page as any) || 1;

    const attributes: string[] = [];

    // only fetch non-blob attributes to speed up the query
    for (const name in Crashreport.rawAttributes) {
      const value = Crashreport.rawAttributes[name];
      // Check if it's BLOB. value.type
      if (!(value.type instanceof DataTypes.BLOB)) {
        attributes.push(name);
      }
    }

    const findAllQuery: any = {
      order: [['created_at', 'DESC']],
      limit: limit,
      offset: offset,
      attributes: attributes
    };

    Crashreport.findAndCountAll(findAllQuery).then((q) => {
      const records = q.rows;
      const count = q.count;
      const pageCount = Math.ceil(count / limit);

      const viewReports = records.map((r) => crashreportToViewJson(true, r));

      const fields =
        viewReports.length
          ? Object.keys(viewReports[0].props)
          : [];

      res.render('crashreport-index', {
        title: 'Crash Reports',
        crashreportsActive: true,
        records: viewReports,
        fields: fields,
        pagination: {
          hide: pageCount <= 1,
          page: page,
          pageCount: pageCount
        }
      });
    }).catch(next);
  });

  breakpad.get('/symfiles', (req: Request, res: Response, next: NextFunction) => {
    const limit = (req.query.limit as any) || 10;
    const offset = (req as any).offset || 0;
    const page = (req.query.page as any) || 1;

    const findAllQuery: any = {
      order: [['created_at', 'DESC']],
      limit: limit,
      offset: offset
    };

    Symfile.findAndCountAll(findAllQuery).then((q) => {
      const records = q.rows;
      const count = q.count;
      const pageCount = Math.ceil(count / limit);

      const viewSymfiles = records.map((r) => symfileToViewJson(r));

      const fields =
        viewSymfiles.length
          ? Object.keys(viewSymfiles[0].props)
          : [];

      res.render('symfile-index', {
        title: 'Symfiles',
        symfilesActive: true,
        records: viewSymfiles,
        fields: fields,
        pagination: {
          hide: pageCount <= 1,
          page: page,
          pageCount: pageCount
        }
      });
    }).catch(next);
  });

  breakpad.get('/symfiles/:id', (req: Request, res: Response, next: NextFunction) => {
    Symfile.findByPk(req.params.id.toString()).then((symfile) => {
      if (!symfile) {
        return res.status(404).send('Symfile not found');
      }

      if ('raw' in req.query) {
        res.set('content-type', 'text/plain');
        if (symfile.contents) {
          res.send(symfile.contents.toString());
          res.end();
        } else {
          fs.createReadStream(Symfile.getPath(symfile)).pipe(res);
        }
      } else {
        Symfile.getContents(symfile).then((contents: string | null) => {
          res.render('symfile-view', {
            title: 'Symfile',
            symfile: symfileToViewJson(symfile, contents || undefined)
          });
        });
      }
    }).catch(next);
  });

  breakpad.get('/crashreports/:id', (req: Request, res: Response, next: NextFunction) => {
    Crashreport.findByPk(req.params.id.toString()).then((report) => {
      if (!report) {
        return res.status(404).send('Crash report not found');
      }
      Crashreport.getStackTrace(report, (err, stackwalk) => {
        if (err) {
          stackwalk = err.stack || err;
          err = null;
        }
        if (err) return next(err);
        const fields = crashreportToViewJson(false, report).props;

        res.render('crashreport-view', {
          title: 'Crash Report',
          stackwalk: stackwalk,
          product: fields.product,
          version: fields.version,
          fields: fields
        });
      });
    }).catch(next);
  });

  breakpad.get('/crashreports/:id/stackwalk', (req: Request, res: Response, next: NextFunction) => {
    // give the raw stackwalk
    Crashreport.findByPk(req.params.id.toString()).then((report) => {
      if (!report) {
        return res.status(404).send('Crash report not found');
      }
      Crashreport.getStackTrace(report, (err, stackwalk) => {
        if (err) return next(err);
        res.set('Content-Type', 'text/plain');
        res.send(stackwalk.toString('utf8'));
      });
    }).catch(next);
  });

  breakpad.get('/crashreports/:id/files/:filefield', (req: Request, res: Response, next: NextFunction) => {
    // download the file for the given id
    const field = req.params.filefield;
    if (!config.get(`customFields:filesById:${field}`)) {
      return res.status(404).send('Crash report field is not a file');
    }

    Crashreport.findByPk(req.params.id.toString()).then((crashreport) => {
      if (!crashreport) {
        return res.status(404).send('Crash report not found');
      }

      const contents = (crashreport as any).get(field);

      // Find appropriate downloadAs file name
      let filename = config.get(`customFields:filesById:${field}:downloadAs`) || field;
      filename = filename.replace('{{id}}', req.params.id);

      if (!config.get('filesInDatabase')) {
        // If this is a string, or a string stored as a blob in an old database,
        // stream the on-disk file instead
        let onDiskFilename = contents;
        if (Buffer.isBuffer(contents)) {
          if (contents.length > 128) {
            // Large, must be an old actual dump stored in the database
            onDiskFilename = null;
          } else {
            onDiskFilename = contents.toString('utf8');
          }
        }
        if (onDiskFilename) {
          // stream
          res.setHeader('content-disposition', `attachment; filename="${filename}"`);
          return fs.createReadStream(path.join(getUploadPath(), onDiskFilename)).pipe(res);
        }
      }

      if (!Buffer.isBuffer(contents)) {
        return res.status(404).send('Crash report field is an unknown type');
      }

      res.setHeader('content-disposition', `attachment; filename="${filename}"`);
      res.send(contents);
    }).catch(next);
  });

  breakpad.get('/api/crashreports', (req: Request, res: Response, next: NextFunction) => {
    // Query for a count of crash reports matching the requested query parameters
    // e.g. /api/crashreports?version=1.2.3
    const where: any = {};
    for (const name in Crashreport.rawAttributes) {
      const value = Crashreport.rawAttributes[name];
       if (!(value.type instanceof DataTypes.BLOB)) {
        if (req.query[name]) {
          where[name] = req.query[name];
        }
      }
    }
    Crashreport.count({ where }).then((result) => {
      res.json({
        count: result
      });
    })
    .catch(next);
  });


  breakpad.use(busboy());
  breakpad.post('/symfiles', (req: Request, res: Response, next: NextFunction) => {
    Symfile.createFromRequest(req, res, (err, symfile) => {
      if (err) return next(err);
      if (symfile) {
          const symfileJson = symfile.toJSON();
          delete symfileJson.contents;
          res.json(symfileJson);
      }
    });
  });

  app.listen(port);
  console.log(`Listening on port ${port}`);
};
