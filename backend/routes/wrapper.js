// flexiWAN SD-WAN software - flexiEdge, flexiManage. For more information go to https://flexiwan.com
// Copyright (C) 2019  flexiWAN Ltd.

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

const cors = require('./cors');
const {verifyPermission} = require('../authenticate');
const mongoose = require('mongoose');
const createError = require('http-errors');
const logger = require('../logging/logging')({module: module.filename, type: 'req'});

/* Create the routers for default list items and list byID items
 * router = express router, created by express.Router()
 * subpath = the url subpath (after the router path specified in app.js)
 * model = database model, created using mongoose.Schema
 * formatErr = function to format for more readable errors
 * checkUpdReq = function to validate and update the request (get the query type and req)
 */

const defaultCheckReq = (qtype, req) => new Promise(function(resolve, reject) {
    resolve({'ok':1});
});

const defaultCheckResp = (qtype, req, res, next, resp) => new Promise(function(resolve, reject) {
    resolve({'ok':1});
});

exports.assignRoutes = function(router, permissionResource, subpath, model, formatErr, checkUpdReq=defaultCheckReq, checkUpdResp=defaultCheckResp) {

    // Parse routes, for now allow only one level for ID, later consider adding multiple
    // Subpath could be '/' or '/:ID' or '/:ID/Field'
    const idIndex = subpath.lastIndexOf('/:');
    const fieldIndex = subpath.lastIndexOf('/');   
    const isById = idIndex==-1?false:true;
    const isField = (idIndex==-1 || fieldIndex==-1 || fieldIndex<=idIndex)?false:true;
    const idName = isById? (isField? subpath.substring(idIndex+2,fieldIndex):subpath.substring(idIndex+2)) : "";
    const fieldName = isField? subpath.substring(fieldIndex+1) : "";
    const r = router.route(subpath);
    r
    // When options message received, reply origin based on whitelist	
    .options(cors.corsWithOptions, (req, res) => { res.sendStatus(200); })
    .get(cors.corsWithOptions, verifyPermission(permissionResource, 'get'), (req,res,next) => {
        var p = (isById)? model.find({_id:mongoose.Types.ObjectId(req.params[idName]), org:req.user.defaultOrg._id}) 
            : model.find({org:req.user.defaultOrg._id});
        p.then((resp) => {
            if (resp.length === 0) return res.status(200).json([]); // return an empty list
            if (isField) resp = resp[0][fieldName];
            // TBD: Add done callback with newresp called when finished
            if (checkUpdResp) checkUpdResp('GET', req, res, next, resp)
            .then((checkresp) => {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                return res.json(resp);
            }, (checkerr) => {
                return next(createError(400, checkerr.message));		
            })
            .catch((checkerr) => {
                return next(createError(500, checkerr.message));		
            });				
        }, (err) => next(createError(500, err.message)))
        .catch((err) => next(createError(500, err.message)));
    })
    .delete(cors.corsWithOptions, verifyPermission(permissionResource, 'del'), (req, res, next) => {
        let session;

        if (checkUpdReq) checkUpdReq('DELETE', req)
        .then((checkreq) => {
            session = checkreq.session;
            if (isField) {
                var set = { $set: { }};
                  set['$set'][fieldName] = [];
                var p = model.update(
                    {_id:mongoose.Types.ObjectId(req.params[idName]), org:req.user.defaultOrg._id}, set, 
                    {upsert: false, multi: false, runValidators: true});
            } else if (isById) var p = model.findOneAndDelete({
                _id:mongoose.Types.ObjectId(req.params[idName]), org:req.user.defaultOrg._id}) 
            else var p = model.remove({org:req.user.defaultOrg._id});

            if (session) { p = p.session(session); }

            p.then(async (resp) => {
                if (resp != null) {
                    if (checkUpdResp) checkUpdResp('DELETE', req, res, next, resp)
                    .then(async (checkresp) => {
                        if (session) {
                            await session.commitTransaction();
                            session = null;
                        }

                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        return res.json(resp);
                    }, async (checkerr) => {
                        if (session) { await session.abortTransaction(); }
                        return next(createError(400, checkerr.message));
                    })
                    .catch(async (checkerr) => {
                        if (session) { await session.abortTransaction(); }
                        return next(createError(500, checkerr.message));
                    });
                } else {
                    if (session) { await session.abortTransaction(); }
                    return next(createError(404, 'element not found'));
                }
            }, (err) => { throw err; })
            .catch(async (err) => {
                if (session) { await session.abortTransaction(); }
                return next(createError(500, err.message))
            });
        }, async (checkerr) => {
            if (session) { await session.abortTransaction(); }
            return next(createError(400, checkerr.message));
        })
        .catch(async (checkerr) => {
            if (session) { await session.abortTransaction(); }
            return next(createError(500, checkerr.message));
        });
    });
    if (isById && !isField) {
        r
        .put(cors.corsWithOptions, verifyPermission(permissionResource, 'put'), (req, res, next) => {
            if (checkUpdReq) checkUpdReq('PUT', req)
            .then((checkreq) => {
                model.findOne({_id:mongoose.Types.ObjectId(req.params[idName]), org:req.user.defaultOrg._id})
                .then(origDoc => {
                    model.findOneAndUpdate({_id:mongoose.Types.ObjectId(req.params[idName]), org:req.user.defaultOrg._id}, 
                    {$set: req.body}, {upsert: false, multi: false, runValidators: true, new: true})
                    .then((resp) => {
                        if (resp != null) {
                            if (checkUpdResp) checkUpdResp('PUT', req, res, next, resp, origDoc)
                            .then((checkresp) => {
                                const { status } = checkresp;
                                res.statusCode = status ? status : 200;
                                res.setHeader('Content-Type', 'application/json');
                                return res.json(resp);
                            }, (checkerr) => {
                                return next(createError(400, checkerr.message));			
                            })
                            .catch((checkerr) => {
                                return next(createError(500, checkerr.message));			
                            });				
                        } else {
                            return next(createError(404, 'element not found'));
                        }
                    }, (err) => {
                        logger.warn("Failed to update resource", {params: {err: err}, req: req });
                        if (formatErr) {
                            const fErr = formatErr(err, req.body);
                            return next(createError(fErr.status, fErr.error));
                        } else {
                            return next(createError(500, err.message));
                        }
                    });
                })
                .catch((err) => next(createError(500, err.message)));				

            }, (checkerr) => {	
                return next(createError(400, checkerr.message));		
            })
            .catch((checkerr) => {
                return next(createError(500, checkerr.message));		
            });
        });
    } else {
        r
        .post(cors.corsWithOptions, verifyPermission(permissionResource, 'post'), (req, res, next) => {
            if (checkUpdReq) checkUpdReq('POST', req)
            .then((checkreq) => {
                if (isField) {
                    var set = { $addToSet: { }};
                      set['$addToSet'][fieldName] = {$each: req.body};
                    var p = model.update(
                        {_id:mongoose.Types.ObjectId(req.params[idName]), org:req.user.defaultOrg._id}, set, 
                        {upsert: false, multi: false, runValidators: true});
                } else {
                    var p = model.create(req.body);
                }
                p.then((resp) => {
                    if (checkUpdResp) checkUpdResp('POST', req, res, next, resp)
                    .then((checkresp) => {
                        logger.info('Resource created successfully', {params: {response: resp}, req: req});
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        return res.json(resp);
                    }, (checkerr) => {
                        return next(createError(400, checkerr.message));		
                    })
                    .catch((checkerr) => {
                        return next(createError(500, checkerr.message));		
                    });	
                }, (err) => {
                    logger.warn("Failed to create resource", {params: {err: err}, req: req });
                    if (formatErr) {
                        const fErr = formatErr(err, req.body);
                        return next(createError(fErr.status, fErr.error));
                    } else {
                        return next(createError(500, err.message));
                    }
                })
                .catch((err) => next(createError(500, err.message)));
            }, (checkerr) => {
                return next(createError(400, checkerr.message));		
            })
            .catch((checkerr) => {
                return next(createError(500, checkerr.message));			
            });			
        });
    }
};