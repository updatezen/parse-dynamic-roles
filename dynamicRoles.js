/*
 * Copyright 2014 Stefan Henze, ConnectMe Inc.
 * Released under the MIT license
 */

'use strict';
/*global exports, require, Parse, console*/
/** @module dynamicRoles */

var _ = require('underscore');
var _roleDefinitions = [];
var _mode;

exports.MODE = {
	IMMEDIATE: "immediate",
	DEFERRED: "deferred"
};

exports.configure = function(roleDefinitions, mode) {
	_roleDefinitions = roleDefinitions;
	_mode = mode || exports.MODE.IMMEDIATE;
};

exports.ensureOwnerHasAccess = function(request, response) {
	//LOG.debug("ensureOwnerHasAccess called");
	if (!request.object.id && request.user) {
		var acl = new Parse.ACL();
		acl.setReadAccess(request.user.id, true);
		acl.setWriteAccess(request.user.id, true);
		request.object.setACL(acl);
	}
	return false;
};

var findRoleDefinition = function(className) {
	//LOG.debug("working on class name", className);
	for (var i = 0; i < _roleDefinitions.length; i++) {
		if (_roleDefinitions[i].collection == className) {
			return _roleDefinitions[i];
		}
	}
	//LOG.errornx("Can't find role definition for class", className);
};

var findRoleSpecs = function(rcoName) {
	for (var i = 0; i < _roleDefinitions.length; i++) {
		if (_roleDefinitions[i].collection == rcoName && _roleDefinitions[i].isRoleCarryingObject) {
			return _roleDefinitions[i].roleSpecs;
		}
	}
	LOG.errornx("Can't find role definition for rco", rcoName);
};

exports.beforeSave = function(request, response) {
	var className = request.object.className;
	var roleDef = findRoleDefinition(className);
	var error = false;

	//we don't do anything if there is no role definition for this entity
	if (!roleDef) {
		response.success();
		return;
	}

	if (_mode == exports.MODE.DEFERRED &&
		(roleDef.isResource || roleDef.isRoleCarryingObject || roleDef.joinsWith || roleDef.isMember)) {
		delayRoleExecutionInline(request.object);
	}

	//add owner access to object if defined as such
	if (!error && roleDef.ensureOwnerHasAccess) {
		error = exports.ensureOwnerHasAccess(request, response);
	}

	//if this is a resource and not a role carrying object, we can set permissions right now. If it was an RCO, we need afterSave because we need the object ID
	if (!error && roleDef.isResource && !roleDef.isRoleCarryingObject) {
		//find the role specs for this object. They can either be defined locally and thus overriding the definition of the RCO, or they are inferred from the RCO.
		var roleSpecs;
		if (roleDef.roleSpecs) {
			roleSpecs = roleDef.roleSpecs;
		} else {
			roleSpecs = findRoleSpecs(roleDef.roleCarryingObject);
		}
		if (roleSpecs) {
			var rcoId;
			if (roleDef.roleCarryingObjectPointer) {
				//we have a simple pointer column that points to the RCO
				rcoId = request.object.get(roleDef.roleCarryingObjectPointer).id;
			} else if (roleDef.getRoleCarryingObjectReference) {
				//RCO is resolved via a synchronous call
				//TODO: This will also need to work with promises in case getting the rco ID needs to be async.
				rcoId = roleDef.getRoleCarryingObjectReference(request.object).id;
			}
			//add the resource access as defined for this entity to its ACL
			exports.setResourceAccess(roleDef.roleCarryingObject, request.object, rcoId, roleSpecs);
		}
	}

	if (error) {
		response.error(error);
	} else {
		response.success();
	}
};

exports.afterSave = function(request) {
	var className = request.object.className;
	var roleDef = findRoleDefinition(className);

	//we don't do anything if there is no role definition for this entity
	if (!roleDef) {
		return;
	}

	//schedule delayed role definition execution
	if (_mode == exports.MODE.DEFERRED &&
		(roleDef.isResource || roleDef.isRoleCarryingObject || roleDef.joinsWith || roleDef.isMember)) {
		//delayRoleExecution(request.object);
	} else {
		doAfterSave(request.object, roleDef, className);
	}

};

var doAfterSave = function(obj, roleDef, className) {
	var promise = new Parse.Promise();
	if (!className) {
		className = obj.className;
		roleDef = findRoleDefinition(className);
	}

	//obj.set("drExecutionCompletedAt", new Date());
	//obj.unset("drNeedsExecutionAfter");
	obj.set("drNeedsExecution", false);
	obj.set("drComesFromDrExecution", true);

	if (roleDef.isRoleCarryingObject) {
		LOG.debug("setting dynamic roles for RCO");
		Parse.Cloud.useMasterKey();

		exports.addRollsToRCO(className, obj.id, roleDef.roleSpecs)
		.then(function success(roleNames) {
			//set resource access if this is also a resource
			var resourcePromise = new Parse.Promise();
			if (roleDef.isResource) {
				exports.setResourceAccess(className, obj, obj.id, roleDef.roleSpecs);
				obj.save(null, {
					success: function(team) {
						LOG.debug("Object resource access saved, all done!");
						resourcePromise.resolve();
					},
					error: function(team, pError) {
						LOG.errornx("Error saving object resource access", pError);
						resourcePromise.reject(pError);
					},
					silent: true
				});
			} else {
				LOG.debug("Object is not a resource, no need to set resource access.");
				resourcePromise.resolve();
			}
			return resourcePromise;
		})
		.then(function success() {
			//set references access if any
			var referencesPromise = new Parse.Promise();
			if (roleDef.references) {
				var referencesPromises = [];
				_.each(roleDef.references, function(reference) {
					var rcoId = obj.id;
					var referenceObjectId = obj.get(reference.referencePointer).id;
					referencesPromises.push(exports.setResourceAccessForOtherObject(roleDef.collection, reference.collection, referenceObjectId, rcoId, reference.roleSpecs));

					//if the join object is a member, set the member's roles as well
					//TODO: There should be a way to optimize this quite a bit
					if (reference.isMember) {
						var roleType = reference.memberRoleType;
						referencesPromises.push(exports.addMember(roleDef.collection, rcoId, roleType, referenceObjectId));
					}
				});
				Parse.Promise.when(referencesPromises).then(function success() {
					referencesPromise.resolve();
				}, function error(pError) {
					referencesPromise.reject(pError);
				});
			} else {
				referencesPromise.resolve();
			}
			return referencesPromise;
		})
		.then(function success() {
			promise.resolve();
		}, function error(pError) {
			LOG.errornx("Error creating roles", pError);
			promise.reject(pError);
		});
	}
	

	//if the entity is a join entity between the RCO and another entity, handle the ACL for the other, joined, entity here
	else if (roleDef.joinsWith) {
		LOG.debug("setting dynamic roles for join");
		Parse.Cloud.useMasterKey();

		//find the role specs for the join entity
		var roleSpecs;
		if (roleDef.joinsWith.roleSpecs) {
			roleSpecs = roleDef.joinsWith.roleSpecs;
		} else {
			roleSpecs = findRoleSpecs(roleDef.roleCarryingObject);
		}

		if (roleSpecs) {
			var rcoId;
			if (roleDef.roleCarryingObjectPointer) {
				//we have a simple pointer column that points to the RCO
				rcoId = obj.get(roleDef.roleCarryingObjectPointer).id;
			} else if (roleDef.getRoleCarryingObjectReference) {
				//RCO is resolved via a synchronous call
				//TODO: This will also need to work with promises in case getting the rco ID needs to be async.
				rcoId = roleDef.getRoleCarryingObjectReference(obj).id;
			}
			var joinObjectId;
			if (roleDef.joinsWith.joinPointer) {
				joinObjectId = obj.get(roleDef.joinsWith.joinPointer).id;
			} else if (roleDef.joinsWith.getJoinReference) {
				joinObjectId = roleDef.joinsWith.getJoinReference(obj).id;
			}

			var promises = [];
			//set ACL for join object
			promises.push(exports.setResourceAccessForOtherObject(roleDef.roleCarryingObject, roleDef.joinsWith.collection, joinObjectId, rcoId, roleSpecs));

			//if the join object is a member, set the member's roles as well
			//TODO: There should be a way to optimize this quite a bit
			if (roleDef.joinsWith.isMember) {
				var roleType;
				if (roleDef.joinsWith.memberRoleTypePointer) {
					roleType = obj.get(roleDef.joinsWith.memberRoleTypePointer);
				} else if (roleDef.joinsWith.getMemberRoleType) {
					roleType = roleDef.joinsWith.getMemberRoleType(obj);
				}
				promises.push(exports.addMember(roleDef.roleCarryingObject, rcoId, roleType, joinObjectId));
			}

			Parse.Promise.when(promises)
			.then(function success() {
				return obj.save();
			})
			.then(function success() {
				LOG.debug("Updated dependent's resource's ACL and added member to role (if this is a member join)");
				promise.resolve();
			}, function error(pError) {
				LOG.errornx("Error updating dependent's resource's ACL or adding member to role", pError);
				promise.reject(pError);
			});
		}
	}

	else {
		LOG.debug("Nothing to do for this delayed object", obj.id);
		obj.save(null, {useMasterKey: true})
		.then(function success() {
			promise.resolve();
		}, function error(pError) {
			LOG.errornx("Error saving role execution, doesn't matter.");
			promise.resolve();
		});
	}
	return promise;
};

var processDelayed = function(delayed) {
	LOG.debug("Running delayed roles for", delayed.id);
	LOG.logObject(delayed);
	var promise = new Parse.Promise();

	var query = new Parse.Query(delayed.get("delayedObjectClassName"))
	.equalTo("objectId", delayed.get("delayedObjectId"));
	query.first({useMasterKey: true})
	.then(function success(delayedObject) {
		if (delayedObject) {
			LOG.debug("Found target object for delay", delayedObject.id);
			return doAfterSave(delayedObject);
		} else {
			LOG.debug("No target object found for", delayed.id);
			promise.resolve();
		}
	})
	.then(function success() {
		promise.resolve();
	}, function error(pError) {
		LOG.errornx("Error processing delayed", pError);
		promise.reject(pError);
	});

	return promise;
};

var DelayedDynamicRoles = Parse.Object.extend("DelayedDynamicRoles");
var delayRoleExecution = function(obj) {
	var delay = new DelayedDynamicRoles();
	delay.set("delayedObjectId", obj.id);
	delay.set("delayedObjectClassName", obj.className);
	delay.set("status", "pending");
	return delay.save(null);
};

var delayRoleExecutionInline = function(obj) {
	if (obj.get("drComesFromDrExecution")) {
		obj.unset("drComesFromDrExecution");
	} else {
		//obj.set("drNeedsExecutionAfter", new Date());
		obj.set("drNeedsExecution", true);
	}
};

Parse.Cloud.job("executeDynamicRolesOld", function(request, status) {
	LOG.debug("executeDynamicRoles job runs");

	var query = new Parse.Query(DelayedDynamicRoles)
	.equalTo("status", "pending")
	.limit(1000);
	query.find({
		success: function(delays) {
			if (delays.length === 0) {
				status.success("No delayed objects found.");
				return;
			}
			var promises = [];
			LOG.debug("Found delays to execute", delays.length);
			_.each(delays, function(delayed) {
				promises.push(processDelayed(delayed));
			});
			Parse.Promise.when(promises)
			.then(function success() {
				LOG.debug("executeDynamicRoles job complete");
				status.success("complete");
			}, function error(pError) {
				LOG.errornx("Error executing delayed roles", pError);
				status.error("Error executing delayed roles");
			});
		},
		error: function(pError) {
			LOG.errornx("Error fetching delayed roles", pError);
		}
	});

});

var executeDynamicRolesForOneCollection = function(remainingRoleDefinitions) {
	var promise = new Parse.Promise();
	var roleDef = remainingRoleDefinitions[0];
	remainingRoleDefinitions = remainingRoleDefinitions.splice(1);
	LOG.debug("checking roles for", roleDef.collection);
	var query = new Parse.Query(roleDef.collection)
	.equalTo("drNeedsExecution", true);
	query.find({useMasterKey: true})
	.then(function foundSome(foundObjects) {
		if (foundObjects.length === 0) {
			LOG.debug("No delayed objects found");
			return;
		}
		var promises = [];
		LOG.debug("Found delays to execute", foundObjects.length);
		_.each(foundObjects, function(foundObject) {
			promises.push(doAfterSave(foundObject, roleDef, roleDef.collection));
		});
		return Parse.Promise.when(promises);
	})
	.then(function success() {
		LOG.debug("executeDynamicRoles job complete for", roleDef.collection);
		if (remainingRoleDefinitions.length > 0) {
			executeDynamicRolesForOneCollection(remainingRoleDefinitions)
			.then(function success() {
				promise.resolve();
			}, function error() {
				promise.reject();
			});
		} else {
			promise.resolve();
		}
	}, function error(pError) {
		LOG.errornx("Error executing delayed roles", pError);
		promise.reject();
	});
	return promise;
};

Parse.Cloud.job("executeDynamicRoles", function(request, status) {
	LOG.debug("executeDynamicRoles job runs");

	exports.executeDynamicRoles()
	.then(function success() {
		LOG.debug("executeDynamicRoles job complete");
		status.success("complete");
	}, function error(pError) {
		LOG.errornx("Error executing delayed roles", pError);
		status.error("Error executing delayed roles");
	});
});

exports.executeDynamicRoles = function() {
	//we need to execute collections sequentially because of dependencies between RCO and other objects.
	return executeDynamicRolesForOneCollection(_roleDefinitions);
};

/**
 * Executes dynamic roles for a single object
 * @param  {Object} obj - The Parse.Object to execute roles for. A role definition must be available for the object.
 * @return {Parse.Promise}     - Return a promise that gets resolved when dynamic roles are executed for the object.
 */
exports.executeDynamicRolesForObject = function(obj) {
	var roleDef = findRoleDefinition(obj.className);
	if (roleDef) {
		var query = new Parse.Query(roleDef.collection);
		return query.get(obj.id)
		.then(function success(fetchedObject) {
			return doAfterSave(obj, roleDef, roleDef.collection);
		});
	} else {
		return Parse.Promise.error("No role definition found");
	}
};

var getRoleName = function(className, objectId, roleType) {
	return className + "-" + objectId + "-" + roleType;
};

/**
 * Adds a new member to a role that relates to a given role-carrying object.
 * @param {String} className           The name of the class of the roll-carrying object
 * @param {String} objIdForRole        ID of the roll-carrying object
 * @param {String} roleType            Role type (one of the role types specified for the RCO)
 * @param {String} memberId            User ID of the member who should be added to the role
 * @return {Promise} Parse.Promise()
 */
exports.addMember = function(className, objIdForRole, roleType, memberId) {
	var promise = new Parse.Promise();
	var roleName = getRoleName(className, objIdForRole, roleType);
	var query = new Parse.Query(Parse.Role);
	query.equalTo("name", roleName);
	query.first({useMasterKey: true})
	.then(function success(role) {
		var roleUsers = role.getUsers();
		var user = new Parse.User();
		user.id = memberId;
		roleUsers.add(user);
		return role.save(null, {silent: true});
	})
	.then(function success() {
		promise.resolve();
	}, function error(pError) {
		LOG.errornx("Error adding member to role", pError);
		promise.reject(pError);
	});
	return promise;
};

/**
 * Adds a roll-carrying object's role to the ACL of a given object. The ACL gets modified in place. The object does not get saved.
 * @param {String} className       The name of the class of the roll-carrying object
 * @param {Object} objToGiveAccess The object which should be a resource of the RCO
 * @param {String} objIdForRole    ID of the roll-carrying object
 * @param {Object} roleSpecs       A map that describes the role with the format "roleSpecs = [{ roleType: 'String', read: true, write: true }]"
 */
exports.setResourceAccess = function(className, objToGiveAccess, objIdForRole, roleSpecs) {
	var objAcl = objToGiveAccess.getACL();
	if (!objAcl) {
		objAcl = new Parse.ACL();
		objToGiveAccess.setACL(objAcl);
	}

	_.each(roleSpecs, function(roleSpec) {
		var roleName = getRoleName(className, objIdForRole, roleSpec.roleType);
		objAcl.setRoleReadAccess(roleName, roleSpec.read);
		objAcl.setRoleWriteAccess(roleName, roleSpec.write);
	});
};

/**
 * Adds a roll-carrying object's role to the ACL of an object given by ID. The object will be loaded, the ACL modified and the object saved
 * before the promise is resolved.
 * @param {String} className          The name of the class of the roll-carrying object
 * @param {Parse.Object} objectType   The object type to query
 * @param {String} objToGiveAccessId  The ID of an object object which should be a resource of the RCO
 * @param {String} objIdForRole       ID of the roll-carrying object
 * @param {Object} roleSpecs          A map that describes the role with the format "roleSpecs = [{ roleType: 'String', read: true, write: true }]"
 * @return {Promise} Parse.Promise()
 */
exports.setResourceAccessForOtherObject = function(className, objectType, objToGiveAccessId, objIdForRole, roleSpecs) {
	Parse.Cloud.useMasterKey();

	var promise = new Parse.Promise();
	var query = new Parse.Query(objectType);
	query.get(objToGiveAccessId)
	.then(function success(obj) {
		exports.setResourceAccess(className, obj, objIdForRole, roleSpecs);
		return obj.save(null, {useMasterKey: true, silent: true});
	})
	.then(function success() {
		promise.resolve();
	}, function error(pError) {
		LOG.errornx("Error in setResourceAccessForOtherObject", pError);
		promise.reject();
	});
	return promise;
};

/**
 * Creates roles for a given object.
 * @param {String} className          The name of the class of the roll-carrying object
 * @param {String} objectId           ID of the roll-carrying object
 * @param {Object} roleSpecs          A map that describes the role with the format "roleSpecs = [{ roleType: 'String', read: true, write: true }]"
 * @return {Promise} Parse.Promise()
 */
exports.addRollsToRCO = function(className, objectId, roleSpecs) {
	Parse.Cloud.useMasterKey();

	var mainPromise = new Parse.Promise();
	
	LOG.debug("Searching for roles");
	var query = new Parse.Query(Parse.Role);
	var roleNames = [];
	_.each(roleSpecs, function(roleSpec) {
		roleNames.push(getRoleName(className, objectId, roleSpec.roleType));
	});
	query.containedIn("name", roleNames);
	query.find({
		success: function(roles) { //query role
			LOG.debug("found something");
			var promises = [];
			_.each(roleNames, function(roleName) {
				var promise = new Parse.Promise();
				promises.push(promise);
				processRoleInQueryResult(roleName, roles, promise);
			});
			Parse.Promise.when(promises).then(function() {
				mainPromise.resolve();
			}, function(error) {
				mainPromise.reject(error);
			});
		},
		error: function(error) { // query role
			LOG.errornx("An error occured querying roles", error);
			mainPromise.reject(error);
		},
	});
	return mainPromise;
};

var findRoleInQueryResult = function(roleName, queryResults) {
	for (var i = 0; i < queryResults.length; i++) {
		var queryResultName = queryResults[i].get("name");
		if (queryResultName == roleName) {
			return queryResults[i];
		}
	}
	return null;
};

var processRoleInQueryResult = function(roleName, roles, promise) {
	var role = findRoleInQueryResult(roleName, roles);
	if (!role) {
		LOG.debug("Role " + roleName + " not found, creating one");
		role = new Parse.Role(roleName, new Parse.ACL());
		role.save(null, {
			success: function() {
				LOG.debug("Just saved the modified or newly created role");
				promise.resolve();
			},
			error: function(obj, error) {
				LOG.errornx("Error saving role", error);
				promise.reject(error);
			}
		});
	} else {
		LOG.debug("Role found, all good", roleName);
		promise.resolve();
	}
};

//logging
var LOG = {};
LOG.debug = function() {
	var message = "";
	for (var i = 0; i < arguments.length; i++) {
		message += "" + arguments[i];
		if (i <= arguments.length - 2) {
			message += ", ";
		}
	}
	console.log(message);
};

LOG.logObject = function(obj) {
	console.log(JSON.stringify(obj, null, 4));
};

LOG.error = function(message, error) {
	var errorLog = "";
	if (error) {
		errorLog = " (Error " + error.code + ": " + error.message + ")";
	}
	console.error(message + errorLog);
};

LOG.errornx = function(message, error) {
	var errorLog = "";
	if (error) {
		errorLog = " (Error " + error.code + ": " + error.message + ")";
	}
	console.error("UNEXPECTED ERROR: " + message + errorLog);
};
