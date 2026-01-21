import config, { getSymbolsPath, getUploadPath } from '../config';
import * as path from 'path';
import * as fs from 'fs-extra';
import cache from './cache';
import { DataTypes, Model, ModelStatic } from 'sequelize';
import sequelize from './db';
import * as tmp from 'tmp';
import { spawn } from 'child_process';

const symbolsPath = getSymbolsPath();

// custom fields should have 'files' and 'params'
const customFields = config.get('customFields') || {};

const walkStack = (minidumpPath: string, symbolPaths: string[], callback: (err: any, report?: any) => void) => {
  const output: Buffer[] = [];
  const errorOutput: Buffer[] = [];
  
  const child = spawn('minidump-stackwalk', [minidumpPath, ...symbolPaths]);

  child.stdout.on('data', (data) => {
    output.push(data);
  });

  child.stderr.on('data', (data) => {
    errorOutput.push(data);
  });

  child.on('close', (code) => {
    if (code !== 0) {
      const errorMsg = Buffer.concat(errorOutput).toString();
      callback(new Error(`minidump-stackwalk exited with code ${code}: ${errorMsg}`));
    } else {
      const report = Buffer.concat(output).toString();
      callback(null, report);
    }
  });

  child.on('error', (err) => {
    callback(err);
  });
};

const schema: any = {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  product: DataTypes.STRING,
  version: DataTypes.STRING
};

const options = {
  indexes: [
    { fields: ['created_at'] }
  ]
};

if (customFields.params) {
  for (const field of customFields.params) {
    schema[field.name] = DataTypes.STRING;
  }
}

if (customFields.files) {
  for (const field of customFields.files) {
    schema[field.name] = config.get('filesInDatabase') ? DataTypes.BLOB : DataTypes.STRING;
  }
}

// We need to extend the Model type to include our static method
interface CrashreportInstance extends Model {
  id: number;
  product: string;
  version: string;
  upload_file_minidump: any; // Buffer or string
  [key: string]: any;
}

interface CrashreportModel extends ModelStatic<CrashreportInstance> {
  getStackTrace(record: CrashreportInstance, callback: (err: any, report?: any) => void): void;
}

const Crashreport = sequelize.define<CrashreportInstance>('crashreports', schema, options) as CrashreportModel;

// Do an arbitrary query to ensure the async init in sequelize.define() has finished before sync'ing
Crashreport.count().then(() => {
  Crashreport.sync({ alter: { drop: false } });
});

Crashreport.getStackTrace = (record: CrashreportInstance, callback: (err: any, report?: any) => void) => {
  if (cache.has(record.id)) {
    return callback(null, cache.get(record.id));
  }

  if (!config.get('filesInDatabase')) {
    // If this is a string, or a string stored as a blob in an old database,
    // just use the on-disk file instead
    let onDiskFilename = record.upload_file_minidump;
    if (Buffer.isBuffer(record.upload_file_minidump)) {
      if (record.upload_file_minidump.length > 128) {
        // Large, must be an old actual dump stored in the database
        onDiskFilename = null;
      } else {
        onDiskFilename = record.upload_file_minidump.toString('utf8');
      }
    }
    if (onDiskFilename) {
      // use existing file, do not delete when done!
      const use_filename = path.join(getUploadPath(), onDiskFilename);
      return walkStack(use_filename, [symbolsPath], (err: any, report: any) => {
        if (!err) cache.set(record.id, report);
        callback(err, report);
      });
    }
  }

  const tmpfile = tmp.fileSync();
  fs.writeFile(tmpfile.name, record.upload_file_minidump).then(() => {
    walkStack(tmpfile.name, [symbolsPath], (err: any, report: any) => {
      tmpfile.removeCallback();
      if (!err) cache.set(record.id, report);
      callback(err, report);
    });
  }).catch((err: any) => {
    tmpfile.removeCallback();
    callback(err);
  });
};

export default Crashreport;
