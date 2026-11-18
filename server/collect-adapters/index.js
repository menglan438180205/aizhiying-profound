'use strict';
/* =========================================================
   collect-adapters/index.js — 适配层出口
   ========================================================= */

const registry = require('./registry');
const http = require('./http-provider');
const local = require('./local');
const { normalize } = require('./normalize');

module.exports = { registry, http, local, normalize };
