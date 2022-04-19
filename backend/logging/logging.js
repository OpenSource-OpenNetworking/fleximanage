// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2021  flexiWAN Ltd.

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

require('winston-mongodb');
const os = require('os');
const configs = require('../configs')();
const mapValues = require('lodash/mapValues');
const isPlainObject = require('lodash/isPlainObject');
const pick = require('lodash/pick');
const kue = require('kue');
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, json, colorize, printf } = format;
const maxLevelLength = 'verbose'.length; // Used for log header alignment

// Env specific information
const hostname = os.hostname();
/**
 * Creates an object with data about the request.
 * @param  {Object} req express request object
 * @return {Object}     request log header object
 */
const createRequestEntry = (req) => {
  return req
    ? {
      reqId: req.id,
      user: req.userId || '',
      ip: req.ip,
      method: req.method,
      url: req.url
    }
    : {};
};

/**
 * Creates an object with data about the job.
 * @param  {Object} job Kue job object
 * @return {Object}     job log header object
 */
const createJobEntry = (job) => {
  return job ? {
    id: job.id,
    deviceId: job.data.metadata.target,
    org: job.data.metadata.org
  }
    : {};
};

/**
 * Creates an object with data about the periodic task.
 * @param  {Object} periodic object with periodic tasks details
 * @return {Object}          periodic log header object
 */
const createPeriodicEntry = (periodic) => {
  return periodic ? {
    task: periodic.task
  }
    : {};
};

/**
 * Creates an object with data about the host.
 * @return {Object} host log entry object
 */
const createEnvEntry = () => {
  return {
    hostname: hostname
  };
};

/**
 * Creates a formated application log entry
 * that contains log headers and log data.
 * @param  {Object} info winston logger info object
 * @return {Object}      formatted log entry
 */
const createLogEntry = (info) => {
  const logEntry = {};
  const logType = info.header.type;

  // Global log fields
  logEntry.level = info.level;
  logEntry.module = info.header.module;
  logEntry.type = logType;
  logEntry.env = createEnvEntry();

  // Event type additional fields
  logEntry.req = createRequestEntry(info.ctx.req);
  logEntry.job = createJobEntry(info.ctx.job);
  logEntry.periodic = createPeriodicEntry(info.ctx.periodic);

  // Event message + data
  logEntry.event = {
    message: info.message,
    params: info.ctx.params ? info.ctx.params : {}
  };

  return logEntry;
};

const fileLogFormat = combine(
  format(info => {
    info = createLogEntry(info);
    return info;
  })(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  json()
);

const consolLogFormat = combine(
  format(info => {
    info.level =
            info.level.toUpperCase() +
            Array(maxLevelLength - info.level.length).join(' ');
    info.params = info.ctx.params ? `, params: ${JSON.stringify(info.ctx.params)}` : '';
    return info;
  })(),
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  printf(
    info => `[${info.timestamp}, ${info.level}]: ${info.message}${info.params}`
  )
);
/**
 * A factory method for creating a logger based
 * on the environment on which the code runs.
 * @param  {string} env environment name
 * @return {Object}     winston logger object
 */
const loggerFactory = (env) => {
  if (env === 'development') {
    const logger = createLogger({
      level: configs.get('logLevel'),
      transports: [
        new transports.File({
          filename: configs.get('logFilePath'),
          format: fileLogFormat,
          maxsize: '300000000', // Max file size is 300MB
          maxFiles: '5',
          tailable: true
        }), new transports.Console({ format: consolLogFormat })
      ]
    });
    return logger;
  } else if (env === 'testing') {
    // Use console.log() in unit tests, as winston logger
    // throws errors when used in unit tests.
    const testLogger = (msg, ctx = {}) => { console.log(msg.message); };
    const testLoggerObj = {
      error: testLogger,
      warn: testLogger,
      info: testLogger,
      verbose: testLogger,
      debug: testLogger,
      silly: testLogger
    };
    return testLoggerObj;
  }

  // Default logger for any other environment
  const logger = createLogger({
    level: configs.get('logLevel'),
    transports: [
      new transports.File({
        filename: configs.get('logFilePath'),
        format: fileLogFormat,
        maxsize: '300000000', // Max file size is 300MB
        maxFiles: '5',
        tailable: true
      })
    ]
  });
  return logger;
};

let logger = null;
/**
 * A singleton that creates the application logger
 * @return {Object} a winston logger
 */
const getLogger = () => {
  if (!logger) logger = loggerFactory(configs.get('environment'));
  return logger;
};
/**
 * @param  {{module: string, type: string}} header an object passed to the 'require' statement
 * @return {void}
 */
const enforceHeaderFields = (header) => {
  if (!(header.hasOwnProperty('module') &&
        header.hasOwnProperty('type'))) {
    throw (new Error('Not all header fields were passed when requiring a logger'));
  }
};

/**
 * Convert a logging message into pure javascript object
 * @param   {Object} obj (e.g. mongodb model)
 * @returns {Object} pure javascript object
 */
const deepObjectConvert = (obj) => {
  return (obj)
    ? (obj instanceof kue.Job)
      ? jobLogger(obj)
      : (obj.toJSON)
        ? obj.toJSON()
        : isPlainObject(obj)
          ? mapValues(obj, deepObjectConvert)
          : (Array.isArray(obj))
            ? obj.map(deepObjectConvert)
            : obj
    : obj;
};

/**
 * Generate job logging info
 * @param   {Job Object} job
 * @returns {Object} javascript object for logging
 */
const jobLogger = (job) => {
  // Create a job logger object and limit tasks size
  const logJob = pick(job, [
    'id', 'type', 'data.message.title', 'data.metadata',
    'created_at', 'started_at'
  ]);
  if (job.data.message && job.data.message.tasks) {
    logJob.data.message.tasks = job.data.message.tasks.map(
      t => JSON.stringify(t).substring(0, 2048)
    );
  }
  if (job.data.response) logJob.data.response = deepObjectConvert(job.data.response);
  return logJob;
};

module.exports = function (header) {
  // Enforce passing global header fields upon requiring the log.
  // This code throws if not all mandatory fields are passed
  enforceHeaderFields(header);

  return {
    error: function (msg, ctx = {}) {
      getLogger().error({
        message: msg,
        ctx: deepObjectConvert(ctx),
        header: header
      });
    },
    warn: function (msg, ctx = {}) {
      getLogger().warn({
        message: msg,
        ctx: deepObjectConvert(ctx),
        header: header
      });
    },
    info: function (msg, ctx = {}) {
      getLogger().info({
        message: msg,
        ctx: deepObjectConvert(ctx),
        header: header
      });
    },
    verbose: function (msg, ctx = {}) {
      getLogger().verbose({
        message: msg,
        ctx: deepObjectConvert(ctx),
        header: header
      });
    },
    debug: function (msg, ctx = {}) {
      getLogger().debug({
        message: msg,
        ctx: deepObjectConvert(ctx),
        header: header
      });
    },
    silly: function (msg, ctx = {}) {
      getLogger().silly({
        message: msg,
        ctx: deepObjectConvert(ctx),
        header: header
      });
    }
  };
};
