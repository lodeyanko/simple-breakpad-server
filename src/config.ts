import nconf from 'nconf';
// @ts-ignore
import nconfYaml from 'nconf-yaml';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

(nconf.formats as any).yaml = nconfYaml;

const SBS_HOME = path.join(os.homedir(), '.simple-breakpad-server');

nconf.file('pwd', {
  file: path.join(process.cwd(), 'breakpad-server.yaml'),
  format: (nconf.formats as any).yaml
});

nconf.file('user', {
  file: path.join(SBS_HOME, 'breakpad-server.yaml'),
  format: (nconf.formats as any).yaml
});

if (process.platform !== 'win32') {
  nconf.file('system', {
    file: '/etc/breakpad-server.yaml',
    format: (nconf.formats as any).yaml
  });
}

nconf.argv();
nconf.env();

nconf.defaults({
  port: 1127,
  baseUrl: '/',
  database: {
    host: 'localhost',
    dialect: 'sqlite',
    storage: path.join(SBS_HOME, 'database.sqlite'),
    logging: false
  },
  customFields: {
    files: [],
    params: [],
    hide: []
  },
  extraField: null,
  dataDir: SBS_HOME,
  filesInDatabase: false,
  fileMaxUploadSize: Infinity
});

// Post-process custom files and params
const customFields = nconf.get('customFields');

// Ensure array
customFields.files = customFields.files || [];
// Always add upload_file_minidump file as first file
customFields.files.splice(0, 0, {
  name: 'upload_file_minidump',
  downloadAs: 'upload_file_minidump.{{id}}.dmp'
});

// If extraField is specified, ensure it's also in customField.params
const extraField = nconf.get('extraField');
if (typeof extraField === 'string') {
  if (customFields.params.indexOf(extraField) === -1) {
    customFields.params.push(extraField);
  }
}

// Ensure array members are objects and build lookup
customFields.filesById = {};
for (let idx = 0; idx < customFields.files.length; idx++) {
  let field = customFields.files[idx];
  if (typeof field === 'string') {
    customFields.files[idx] = {
      name: field
    };
  }
  customFields.filesById[customFields.files[idx].name] = customFields.files[idx];
}

// Ensure array
customFields.params = customFields.params || [];
// Always add ip as first params
customFields.params.splice(0, 0, {
  name: 'ip'
});

// Ensure array members are objects and build lookup
customFields.paramsById = {};
for (let idx = 0; idx < customFields.params.length; idx++) {
  let field = customFields.params[idx];
  if (typeof field === 'string') {
    customFields.params[idx] = {
      name: field
    };
  }
  customFields.paramsById[customFields.params[idx].name] = customFields.params[idx];
}

nconf.set('customFields', customFields);

// Extend nconf with custom methods
// We can't easily extend the types of nconf without declaration merging,
// so we'll just attach them and cast when using, or export functions.
// Exporting functions is cleaner in TS.

export function getSymbolsPath(): string {
  return path.join(nconf.get('dataDir'), 'symbols');
}

export function getUploadPath(): string {
  return path.join(nconf.get('dataDir'), 'uploads');
}

// Ensure symbols path exists
fs.mkdirsSync(getSymbolsPath());

export default nconf;
