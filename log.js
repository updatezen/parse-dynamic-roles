/*
 * Copyright 2014 Stefan Henze, ConnectMe Inc.
 * Released under the MIT license
 */

'use strict';
/*global console, exports, JSON*/
/** @module log */

/**
 * Saves a debug message in the Parse console
 * @param  {String} message - The message to print
 */
exports.debug = function() {
	var message = "";
	for (var i = 0; i < arguments.length; i++) {
		message += "" + arguments[i];
		if (i <= arguments.length - 2) {
			message += ", ";
		}
	}
	console.log(message);
};

exports.logObject = function(obj) {
	console.log(JSON.stringify(obj, null, 4));
};

exports.error = function(message, error) {
	var errorLog = "";
	if (error) {
		errorLog = " (Error " + error.code + ": " + error.message + ")";
	}
	console.error(message + errorLog);
};

exports.errornx = function(message, error) {
	var errorLog = "";
	if (error) {
		errorLog = " (Error " + error.code + ": " + error.message + ")";
	}
	console.error("UNEXPECTED ERROR: " + message + errorLog);
};
