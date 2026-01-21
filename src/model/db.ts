import config from '../config';
import { Sequelize, Options } from 'sequelize';

const dbConfig = config.get('database');
const options: Options = { ...dbConfig };

options.define = options.define || {};

const defaultModelOptions = {
  timestamps: true,
  underscored: true
};

options.define = Object.assign(options.define, defaultModelOptions);

const sequelize = new Sequelize(options.database!, options.username!, options.password!, options);

export default sequelize;
