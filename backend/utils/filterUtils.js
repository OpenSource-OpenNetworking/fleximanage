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

/**
 * Converts API query filter operation to mongoose expression
 * @param {Object} filter a filter object from API request
 * @param {String} filter.key Key to be filtered by
 * @param {String} filter.op filter operation [==, !=, contains...]
 * @param {String} filter.val Value to be filtered
 * @returns {Object} Mongoose expression for the $match stage
*/
const getFilterExpression = ({ key, op, val }) => {
  // The key is required
  if (!key) return undefined;
  // Two sides case '?' means 'A' && 'B' - for example "device?.name" be replaced by
  // 'cond': [{"deviceA.name": "DeviceName"}, {"deviceB.name": "DeviceName"}]
  // where 'cond' depends on 'op' - if negative it will be '$and' and '$or' if opposite
  // Example: 'op' is '==' or 'contains' the condition in that case will be
  // { $or: [{"deviceA.name": "DeviceName"}, {"deviceB.name": "DeviceName"}] }
  if (key.includes('?')) {
    const cond = op.includes('!') ? '$and' : '$or';
    return {
      [cond]: ['A', 'B'].map(side => getFilterExpression({
        key: key.replace(/\?/g, side), op, val
      }))
    };
  }
  // Special case for dates filtering
  if (['time', 'date', 'created_at'].includes(key)) {
    const date1 = new Date(val);
    const date2 = new Date(val);
    date2.setDate(date1.getDate() + 1); // beginning of the next day
    switch (op) {
      case '==':
        return { $and: [{ [key]: { $gte: date1 } }, { [key]: { $lt: date2 } }] };
      case '!=':
        return { $and: [{ [key]: { $lt: date1 } }, { [key]: { $gte: date2 } }] };
      case 'in last days':
        date1.setDate(date1.getDate() - 3); // let's do the last 3 days...
        return { $and: [{ [key]: { $lt: date1 } }, { [key]: { $gte: date2 } }] };
      case '<':
        return { [key]: { $lt: date1 } };
      case '>':
        return { [key]: { $gte: date2 } };
      case '<=':
        return { [key]: { $lt: date2 } };
      case '>=':
        return { [key]: { $gte: date1 } };
      default:
        return undefined;
    }
  }
  // all other types
  const isString = typeof val === 'string';
  switch (op) {
    case '==':
      return { [key]: isString ? new RegExp('^' + val + '$', 'i') : val };
    case '!=':
      return { [key]: isString ? new RegExp('^(?!' + val + '$)', 'i') : { $ne: val } };
    case 'contains':
      return { [key]: new RegExp(val, 'i') };
    case '!contains':
      return { [key]: new RegExp('^((?!' + val + ').)*$', 'i') };
    case '<':
      return { [key]: { $lt: val } };
    case '>':
      return { [key]: { $gt: val } };
    case '<=':
      return { [key]: { $lte: val } };
    case '>=':
      return { [key]: { $gte: val } };
    case 'in':
      if (!Array.isArray(val)) val = val.split(',');
      return { [key]: { $in: val } };
    default:
      return undefined;
  }
};

/**
 * Check if object passes array of filters
 * @param {Object} obj an object to test if it passes filters
 * @param {Array}  filters an array of filters from API request
 * @returns {boolean} returns true if passed
*/
const passFilters = (obj, filters) => {
  // if no filters then returns true
  if (!Array.isArray(filters) || filters.length === 0) return true;
  // the object must pass every filter
  return filters.every(({ key, op, val }) => {
    if (!key || !op) return false;
    const props = key.split('.');
    let objVal = obj;
    // the key can be complex, like 'data.message.title'
    for (const prop of props) {
      if (!objVal.hasOwnProperty(prop)) return false;
      objVal = objVal[prop];
    }
    // must be the same type to compare
    switch (typeof objVal) {
      case 'number':
        val = +val; break;
      case 'boolean':
        val = val === true || val === 'true'; break;
    }
    const isString = typeof val === 'string';
    switch (op) {
      case '==':
        return isString ? (new RegExp('^' + val + '$', 'i')).test(objVal) : val === objVal;
      case '!=':
        return isString ? !(new RegExp('^' + val + '$', 'i')).test(objVal) : val !== objVal;
      case '<=':
        return objVal <= val;
      case '>=':
        return objVal >= val;
      case '<':
        return objVal < val;
      case '>':
        return objVal > val;
      case 'contains':
        return (new RegExp(val, 'i')).test(objVal);
      case '!contains':
        return (new RegExp('^((?!' + val + ').)*$', 'i')).test(objVal);
      case 'in':
        if (!Array.isArray(val)) val = val.split(',');
        return val.includes(objVal);
      default:
        return false;
    }
  });
};

/**
 * Converts array of filters from API request to array of mongoose expressions
 * @param {Array}  filters an array of filters from API request
 * @returns {Array} an array of mongoose match expressions
 */
const getMatchFilters = (filters) => {
  const matchFilters = [];
  for (const filter of filters) {
    const filterExpr = getFilterExpression(filter);
    if (filterExpr !== undefined) {
      matchFilters.push(filterExpr);
    } else {
      throw new Error('There is an error in filter: ' + JSON.stringify(filter));
    }
  }
  return matchFilters;
};

module.exports = {
  getMatchFilters,
  passFilters
};
