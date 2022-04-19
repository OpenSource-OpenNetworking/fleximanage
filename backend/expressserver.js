// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2020  flexiWAN Ltd.

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

const { version } = require('./package.json');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const configs = require('./configs')();
const clientConfig = configs.getClientConfig();
const swaggerUI = require('swagger-ui-express');
const yamljs = require('yamljs');
const express = require('express');
const cors = require('./routes/cors');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const { OpenApiValidator } = require('express-openapi-validator');
const openapiRouter = require('./utils/openapiRouter');
const createError = require('http-errors');

const passport = require('passport');
const auth = require('./authenticate');
const { connectRouter } = require('./routes/connect');
const morgan = require('morgan');
const logger = require('./logging/logging')({ module: module.filename, type: 'req' });
const { reqLogger, errLogger } = require('./logging/request-logging');
const serialize = require('serialize-javascript');

// periodic tasks
const deviceStatus = require('./periodic/deviceStatus')();
const deviceQueues = require('./periodic/deviceQueue')();
const deviceSwVersion = require('./periodic/deviceSwVersion')();
const deviceSwUpgrade = require('./periodic/deviceperiodicUpgrade')();
const notifyUsers = require('./periodic/notifyUsers')();
const appRules = require('./periodic/appRules')();
const applications = require('./periodic/applications')();
const statusesInDb = require('./periodic/statusesInDb')();

require('./applicationLogic/initializeApps');

// rate limiter
const rateLimit = require('express-rate-limit');
const RateLimitStore = require('./rateLimitStore');

// Internal routers definition
const adminRouter = require('./routes/admin');

// WSS
const WebSocket = require('ws');
const connections = require('./websocket/Connections')();
const broker = require('./broker/broker.js');
const roleSelector = require('./utils/roleSelector')(configs.get('redisUrl'));

class ExpressServer {
  constructor (port, securePort, openApiYaml) {
    this.port = port;
    this.securePort = securePort;
    this.app = express();
    this.openApiPath = openApiYaml;
    this.schema = yamljs.load(openApiYaml);
    const restServerUrl = configs.get('restServerUrl', 'list');
    const servers = this.schema.servers.filter(server => server.url.includes(restServerUrl));
    if (servers.length === 0) {
      this.schema.servers.unshift(...restServerUrl.map((restServer, idx) => {
        return {
          description: `Local Server #${idx + 1}`,
          url: restServer + '/api'
        };
      }));
    };

    this.setupMiddleware = this.setupMiddleware.bind(this);
    this.addErrorHandler = this.addErrorHandler.bind(this);
    this.onError = this.onError.bind(this);
    this.onListening = this.onListening.bind(this);
    this.launch = this.launch.bind(this);
    this.close = this.close.bind(this);

    this.setupMiddleware();
  }

  async setupMiddleware () {
    // this.setupAllowedMedia();
    this.app.use((req, res, next) => {
      console.log(`${req.method}: ${req.url}`);
      return next();
    });

    // A middleware that adds a unique request ID for each request
    // or uses the existing request ID, if there is one.
    // THIS MIDDLEWARE MUST BE ASSIGNED FIRST.
    // this.app.use((req, res, next) => {
    //   // Add unique ID to each request
    //   req.id = req.get('X-Request-Id') || uuid();
    //   res.set('X-Request-Id', req.id);

    //   // Set the remote address IP on the request
    //   req.ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    //   next();
    // });

    // Request logging middleware - must be defined before routers.
    this.app.use(reqLogger);
    this.app.set('trust proxy', true); // Needed to get the public IP if behind a proxy

    // Don't expose system internals in response headers
    this.app.disable('x-powered-by');

    // Use morgan request logger in development mode
    if (configs.get('environment') === 'development') this.app.use(morgan('dev'));

    // Initialize websocket traffic handler role selector
    // On every new websocket connection it will try to set itself as active
    roleSelector.initializeSelector('websocketHandler');

    // Start periodic device tasks
    deviceStatus.start();
    deviceQueues.start();
    deviceSwVersion.start();
    deviceSwUpgrade.start();
    notifyUsers.start();
    appRules.start();
    applications.start();
    statusesInDb.start();

    // Secure traffic only
    this.app.all('*', (req, res, next) => {
      // Allow Let's encrypt certbot to access its certificate dirctory
      if (!configs.get('shouldRedirectHttps', 'boolean') ||
          req.secure || req.url.startsWith('/.well-known/acme-challenge')) {
        return next();
      } else {
        return res.redirect(
          307, 'https://' + req.hostname + ':' + configs.get('redirectHttpsPort') + req.url
        );
      }
    });

    // Global rate limiter to protect against DoS attacks
    // Windows size of 5 minutes
    const inMemoryStore = new RateLimitStore(5 * 60 * 1000);
    const rateLimiter = rateLimit({
      store: inMemoryStore,
      // Rate limit for requests in 5 min per IP address
      max: configs.get('userIpReqRateLimit', 'number'),
      message: 'Request rate limit exceeded',
      onLimitReached: (req, res, options) => {
        logger.error(
          'Request rate limit exceeded. blocking request', {
            params: { ip: req.ip },
            req: req
          });
      }
    });
    this.app.use(rateLimiter);

    // General settings here
    this.app.use(cors.cors);
    this.app.use(bodyParser.json());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: false }));
    this.app.use(cookieParser());

    // Routes allowed without authentication
    this.app.get('/', (req, res) => this.sendIndexFile(res));
    this.app.use(express.static(path.join(__dirname, configs.get('clientStaticDir'))));

    // Secure traffic only
    this.app.all('*', (req, res, next) => {
      // Allow Let's encrypt certbot to access its certificate dirctory
      if (!configs.get('shouldRedirectHttps', 'boolean') ||
          req.secure || req.url.startsWith('/.well-known/acme-challenge')) {
        return next();
      } else {
        return res.redirect(
          307, 'https://' + req.hostname + ':' + configs.get('redirectHttpsPort') + req.url
        );
      }
    });

    // no authentication
    this.app.use('/api/connect', connectRouter);
    this.app.use('/api/users', require('./routes/users'));

    // add API documentation
    this.app.use('/api-docs', swaggerUI.serve, swaggerUI.setup(this.schema));

    // initialize passport and authentication
    this.app.use(passport.initialize());

    // Enable db admin only in development mode
    if (configs.get('environment') === 'development') {
      logger.warn('Warning: Enabling UI database access');
      // mongo database UI
      const mongoExpress = require('mongo-express/lib/middleware');
      const mongoExpressConfig = require('./mongo_express_config');
      const expressApp = await mongoExpress(mongoExpressConfig);
      this.app.use('/admindb', expressApp);
    }

    // Enable routes for non-authorized links
    this.app.use('/ok', express.static(path.join(__dirname, 'public', 'ok.html')));
    this.app.use('/spec', express.static(path.join(__dirname, 'api', 'openapi.yaml')));
    this.app.get('/hello', (req, res) => res.send('Hello World'));

    this.app.get('/api/version', (req, res) => res.json({ version }));
    this.app.get('/api/restServers', (req, res) => res.json({ version }));

    this.app.use(cors.corsWithOptions);
    this.app.use(auth.verifyUserJWT);
    // this.app.use(auth.verifyPermission);

    try {
      // FIXME: temporary map the OLD routes
      // this.app.use('/api/devices', require('./routes/devices'));
      // this.app.use('/api/devicestats', require('./routes/deviceStats'));
      // this.app.use('/api/jobs', require('./routes/deviceQueue'));
      this.app.use('/api/portals', require('./routes/portals'));
    } catch (error) {
      logger.error('Error: Can\'t connect OLD routes');
    }

    // Intialize routes
    this.app.use('/api/admin', adminRouter);

    // reserved for future use
    // this.app.get('/login-redirect', (req, res) => {
    //   res.status(200);
    //   res.json(req.query);
    // });
    // this.app.get('/oauth2-redirect.html', (req, res) => {
    //   res.status(200);
    //   res.json(req.query);
    // });

    const validator = new OpenApiValidator({
      apiSpec: this.openApiPath,
      validateRequests: configs.get('validateOpenAPIRequest', 'boolean'),
      validateResponses: configs.get('validateOpenAPIResponse', 'boolean')
    });

    validator
      .install(this.app)
      .then(async () => {
        await this.app.use(openapiRouter(this.schema.components.schemas));
        await this.launch();
        logger.info('Express server running');
      });
  }

  sendIndexFile (res) {
    const transformIndex = (origIndex) => {
      let modifiedIndex = configs.get('removeBranding', 'boolean')
        ? origIndex.replace('<title>FlexiWAN Management</title>',
          `<title>${configs.get('companyName')} Management</title>`)
        : origIndex;
      const m = modifiedIndex.match(/const __FLEXIWAN_SERVER_CONFIG__=(.*?);/);
      if (m instanceof Array && m.length > 0) { // successful match
        // eslint-disable-next-line no-eval
        const newConfig = eval('(' + m[1] + ')');
        // Update default config with backend variables
        for (const c in clientConfig) {
          newConfig[c] = clientConfig[c];
        }
        modifiedIndex = modifiedIndex.replace(m[0],
          'const __FLEXIWAN_SERVER_CONFIG__=' + serialize(newConfig, { isJSON: true }) + ';');
      }
      return modifiedIndex;
    };

    const indexFile =
        fs.readFileSync(path.join(__dirname, configs.get('clientStaticDir'), 'index.html'));
    const transformedIndex = transformIndex(indexFile.toString());
    res.send(transformedIndex);
  }

  addErrorHandler () {
    // "catchall" handler, for any request that doesn't match one above, send back index.html file.
    this.app.get('*', (req, res, next) => {
      logger.info('Route not found', { req: req });
      this.sendIndexFile(res);
    });

    // catch 404 and forward to error handler
    this.app.use(function (req, res, next) {
      next(createError(404));
    });

    // Request error logger - must be defined after all routers
    // Set log severity on the request to log errors only for 5xx status codes.
    this.app.use((err, req, res, next) => {
      req.logSeverity = err.status || 500;
      next(err);
    });
    this.app.use(errLogger);

    /**
     * suppressed eslint rule: The next variable is required here, even though it's not used.
     *
     ** */
    // eslint-disable-next-line no-unused-vars
    this.app.use((error, req, res, next) => {
      const errorResponse = error.error || error.message || error.errors || 'Unknown error';
      res.status(error.status || 500);
      res.type('json');
      res.json({ error: errorResponse });
    });
  }

  /**
   * Event listener for HTTP/HTTPS server "error" event.
   */
  onError (port) {
    return function (error) {
      if (error.syscall !== 'listen') {
        throw error;
      }

      const bind = 'Port ' + port;

      // handle specific listen errors with friendly messages
      /* eslint-disable no-unreachable */
      switch (error.code) {
        case 'EACCES':
          console.error(bind + ' requires elevated privileges');
          process.exit(1);
          break;
        case 'EADDRINUSE':
          console.error(bind + ' is already in use');
          process.exit(1);
          break;
        default:
          throw error;
      }
    };
  }

  /**
  * Event listener for HTTP server "listening" event.
  */
  onListening (server) {
    return function () {
      const addr = server.address();
      const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
      console.debug('Listening on ' + bind);
    };
  }

  async launch () {
    this.addErrorHandler();

    try {
      this.server = http.createServer(this.app);

      this.options = {
        key: fs.readFileSync(path.join(__dirname, 'bin', configs.get('httpsCertKey'))),
        cert: fs.readFileSync(path.join(__dirname, 'bin', configs.get('httpsCert')))
      };
      this.secureServer = https.createServer(this.options, this.app);

      // setup wss here
      this.wss = new WebSocket.Server({
        server: configs.get('shouldRedirectHttps', 'boolean') ? this.secureServer : this.server,
        verifyClient: connections.verifyDevice
      });

      connections.registerConnectCallback('broker', broker.deviceConnectionOpened);
      connections.registerCloseCallback('broker', broker.deviceConnectionClosed);
      connections.registerCloseCallback('deviceStatus', deviceStatus.deviceConnectionClosed);

      this.wss.on('connection', connections.createConnection);
      console.log('Websocket server running');

      this.server.listen(this.port, () => {
        console.log('HTTP server listening on port', { params: { port: this.port } });
      });
      this.server.on('error', this.onError(this.port));
      this.server.on('listening', this.onListening(this.server));

      this.secureServer.listen(this.securePort, () => {
        console.log('HTTPS server listening on port', { params: { port: this.securePort } });
      });
      this.secureServer.on('error', this.onError(this.securePort));
      this.secureServer.on('listening', this.onListening(this.secureServer));
    } catch (error) {
      console.log('Express server lunch error', { params: { message: error.message } });
    }
  }

  async close () {
    if (this.server !== undefined) {
      await this.server.close();
      console.log(`HTTP Server on port ${this.port} shut down`);
    }
    if (this.secureServer !== undefined) {
      await this.secureServer.close();
      console.log(`HTTPS Server on port ${this.securePort} shut down`);
    }
  }
}

module.exports = ExpressServer;
