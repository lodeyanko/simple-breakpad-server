import config, { getSymbolsPath } from '../config';
import cache from './cache';
import { DataTypes, Model, ModelStatic, Transaction } from 'sequelize';
import sequelize from './db';
import * as fs from 'fs-extra';
import * as path from 'path';
import streamToArray from 'stream-to-array';
import { Request, Response, NextFunction } from 'express';

const symbolsPath = getSymbolsPath();
const COMPOSITE_INDEX = 'compositeIndex';

const schema = {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  os: {
    type: DataTypes.STRING,
    unique: COMPOSITE_INDEX
  },
  name: {
    type: DataTypes.STRING,
    unique: COMPOSITE_INDEX
  },
  code: {
    type: DataTypes.STRING,
    unique: COMPOSITE_INDEX
  },
  arch: {
    type: DataTypes.STRING,
    unique: COMPOSITE_INDEX
  },
  contents: DataTypes.TEXT
};

const options = {
  indexes: [
    { fields: ['created_at'] }
  ]
};

interface SymfileAttributes {
  id?: number;
  os?: string;
  name?: string;
  code?: string;
  arch?: string;
  contents?: string | null;
  created_at?: Date;
  updated_at?: Date;
}

interface SymfileInstance extends Model<SymfileAttributes>, SymfileAttributes {}

interface SymfileModel extends ModelStatic<SymfileInstance> {
  getPath(symfile: SymfileInstance | SymfileAttributes): string;
  saveToDisk(symfile: SymfileInstance | SymfileAttributes, prune: boolean): Promise<void>;
  getContents(symfile: SymfileInstance): Promise<string | null>;
  createFromRequest(req: Request, res: Response, callback: (err: any, symfile?: SymfileInstance) => void): void;
  didPrune?: boolean;
}

const Symfile = sequelize.define<SymfileInstance>('symfiles', schema, options) as SymfileModel;

Symfile.getPath = (symfile: SymfileInstance | SymfileAttributes) => {
  const symfileDir = path.join(symbolsPath, symfile.name!, symfile.code!);
  let symbol_name = symfile.name!;
  if (path.extname(symbol_name).toLowerCase() === '.pdb') {
    symbol_name = symbol_name.slice(0, -4);
  }
  symbol_name += '.sym';
  return path.join(symfileDir, symbol_name);
};

Symfile.saveToDisk = (symfile: SymfileInstance | SymfileAttributes, prune: boolean) => {
  const filePath = Symfile.getPath(symfile);

  if (!symfile.contents) {
    if (!prune) {
      // If at startup, and the option was set back to "filesInDatabase", read them back from disk?
      // Check if id exists (it should if we are restoring)
      if (!symfile.id) return Promise.resolve();
      
      return fs.pathExists(filePath).then((exists) => {
        if (exists) {
          console.log(`Restoring contents to database from symfile ${symfile.id}, ${filePath}`);
          return fs.readFile(filePath, 'utf8').then((contents) => {
            Symfile.didPrune = true;
            return Symfile.update({ contents: contents }, { where: { id: symfile.id } }).then(() => {});
          });
        }
      });
    } else {
      // At startup, pruning, already no contents, great!
      return Promise.resolve();
    }
  }

  return fs.mkdirs(path.dirname(filePath)).then(() => {
    return fs.writeFile(filePath, symfile.contents!).then(() => {
      if (prune && symfile.id) {
        console.log(`Pruning contents from database for symfile ${symfile.id}, file saved at ${filePath}`);
        symfile.contents = null;
        Symfile.didPrune = true;
        return Symfile.update({ contents: null }, { where: { id: symfile.id } }).then(() => {});
      }
    });
  });
};

Symfile.getContents = (symfile: SymfileInstance) => {
  if (config.get('filesInDatabase')) {
    return Promise.resolve(symfile.contents);
  } else {
    return fs.readFile(Symfile.getPath(symfile), 'utf8');
  }
};

Symfile.createFromRequest = (req: Request, res: Response, callback: (err: any, symfile?: SymfileInstance) => void) => {
  const props: any = {};
  const streamOps: Promise<any>[] = [];
  const busboy = (req as any).busboy;

  busboy.on('file', (fieldname: string, file: any, filename: string, encoding: string, mimetype: string) => {
    streamOps.push(streamToArray(file).then((parts: any[]) => {
      const buffers: Buffer[] = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        buffers.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
      }
      return Buffer.concat(buffers);
    }).then((buffer) => {
      if (fieldname === 'symfile') {
        props[fieldname] = buffer;
      }
    }));
  });

  busboy.on('finish', () => {
    Promise.all(streamOps).then(() => {
      if (!Object.prototype.hasOwnProperty.call(props, 'symfile')) {
        res.status(400);
        throw new Error('Form must include a "symfile" field');
      }

      const contents = props.symfile;
      const headerLine = contents.toString('utf8', 0, 4096).split('\n')[0];
      const headerMatch = headerLine.match(/^(MODULE) ([^ ]+) ([^ ]+) ([0-9A-Fa-f]+) (.*)/);

      if (!headerMatch) {
         throw new Error('Could not parse header (expecting MODULE as first line)');
      }

      const [line, dec, os, arch, code, name] = headerMatch;

      if (dec !== 'MODULE') {
        const msg = 'Could not parse header (expecting MODULE as first line)';
        throw new Error(msg);
      }

      const symProps: SymfileAttributes = {
        os: os,
        arch: arch,
        code: code,
        name: name,
        contents: contents.toString('utf8')
      };

      sequelize.transaction((t: Transaction) => {
        const whereDuplicated = {
          where: { os: os, arch: arch, code: code, name: name }
        };

        return Symfile.findOne({ ...whereDuplicated, transaction: t }).then((duplicate) => {
          const p = duplicate ? duplicate.destroy({ transaction: t }) : Promise.resolve();
          return p.then(() => {
            return Symfile.saveToDisk(symProps, false).then(() => {
              if (!config.get('filesInDatabase')) {
                delete symProps.contents;
              }
              return Symfile.create(symProps, { transaction: t }).then((symfile) => {
                cache.clear();
                callback(null, symfile);
              });
            });
          });
        });
      }).catch((err) => {
          callback(err);
      });

    }).catch((err) => {
      callback(err);
    });
  });

  req.pipe(busboy);
};

export default Symfile;
