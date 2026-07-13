#!/usr/bin/env node
/*
 * verify_all_runner.js — headless JS side of the 9-style cross-check harness.
 *
 * Loads ../arp-styles.js (the single source of the gens), runs _selfTest, then
 * emits each style's gen output as JSON on the canonical pool/opts so the Python
 * harness (verify_all.py) can diff JS-vs-Python element-by-element.
 *
 * Usage:
 *   node verify_all_runner.js            # prints {selfTest, results:{key:[steps...]}}
 *   node verify_all_runner.js <key>      # prints just that style's steps array
 *
 * Canonical cross-check inputs (must match verify_all.py):
 *   pool = [60,62,64,67,69]   (L=5)
 *   opts = {length:64, seed:1994, octaves:3, ...each style's param defaults}
 *
 * NOTE: per the design "...each style's param defaults" are applied LAST, so a
 * style param that shares a universal key (collatz `seed`, pink `octaves`)
 * overrides the universal value. Both sides of the harness apply this identically.
 */
'use strict';
var path = require('path');
var api = require(path.join(__dirname, '..', 'arp-styles.js'));

var POOL = [60, 62, 64, 67, 69];
var BASE = { length: 64, seed: 1994, octaves: 3 };

function optsFor(style) {
  var o = { length: BASE.length, seed: BASE.seed, octaves: BASE.octaves };
  // style param defaults applied LAST (override universal keys on collision)
  for (var i = 0; i < style.params.length; i++) {
    var p = style.params[i];
    o[p.name] = p.default;
  }
  return o;
}

function run(key) {
  var st = api.STYLES[key];
  return st.gen(POOL, optsFor(st));
}

if (require.main === module) {
  var arg = process.argv[2];
  if (arg) {
    process.stdout.write(JSON.stringify(run(arg)));
  } else {
    var selfTest = api._selfTest({ pool: POOL, length: BASE.length, seed: BASE.seed, octaves: BASE.octaves });
    var results = {};
    Object.keys(api.STYLES).forEach(function (k) { results[k] = run(k); });
    process.stdout.write(JSON.stringify({ selfTest: selfTest, results: results }));
  }
}

module.exports = { POOL: POOL, BASE: BASE, optsFor: optsFor, run: run };
