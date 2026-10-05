#!/usr/bin/env node
/** Reset the demo store back to the deck seed. */
import { reset, stats } from '../src/store/db.js';

reset();
console.log('data store reset to the deck seed');
console.log(stats());
