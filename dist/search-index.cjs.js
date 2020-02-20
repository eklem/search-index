'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var fii = _interopDefault(require('fergies-inverted-index'));
var tv = _interopDefault(require('term-vector'));

function util (fii) {
  const prefetchSearchableFields = () => {
    const tmp = [];
    return new Promise((resolve) => {
      fii.STORE.createKeyStream({
        gte: '￮FIELD!',
        lte: '￮FIELD￮￮'
      }).on('data', d => tmp.push(d.split('￮')[2]))
        .on('end', () => resolve(global.searchableFields = tmp));
    })
  };

  const countDocs = () => {
    let i = 0;
    return new Promise((resolve) => {
      fii.STORE.createKeyStream({
        gte: '￮DOC￮!',
        lte: '￮DOC￮￮'
      }).on('data', () => i++)
        .on('end', () => resolve(global.D = i));
    })
  };

  const calibrate = () => {
    // can handle lazy opening
    if (fii.STORE.isOpen()) {
      return prefetchSearchableFields().then(countDocs)
    } else setTimeout(calibrate, 1000); // will rerun function every 1000ms until fii.STORE.isOpen()
  };

  return {
    countDocs: countDocs,
    prefetchSearchableFields: prefetchSearchableFields,
    calibrate: calibrate
  }
}

function writer (fii) {

  const scoreArrayTFIDF = arr => {
    const v = tv(arr);
    const mostTokenOccurances = v.reduce((acc, cur) => Math.max(cur.positions.length, acc), 0);
    return v
      .map(item => item.term[0] + '#'
           + (((item.positions.length / mostTokenOccurances)).toFixed(2)))
  };

  // traverse object, tokenising all leaves (strings to array) and then
  // scoring them
  const traverseObject = obj => Object.entries(obj).reduce((acc, cur) => {  
    if (cur[0] == '_id') {
      acc[cur[0]] = cur[1];  // return _id "as is"
    } else if (Array.isArray(cur[1])) {
      // split up cur[1] into an array or strings and an array of
      // other things. Then term-vectorize strings and recursively
      // process other things.
      const strings = scoreArrayTFIDF(
        cur[1].filter(item => typeof item === 'string')
      );
      const notStrings = cur[1].filter(
        item => typeof item != 'string'
      ).map(traverseObject);
      acc[cur[0]] = strings.concat(notStrings);
    }
    else if (typeof cur[1] === 'object') {
      acc[cur[0]] = traverseObject(cur[1]);
    }
    else {
      acc[cur[0]] = scoreArrayTFIDF(
        cur[1].toString().split(' ')
      );  
    }
    return acc
  }, {});

  const PUT = docs => fii.PUT(docs.map(traverseObject));

  return {
    // TODO: surely this can be DELETE: fii.DELETE?
    DELETE: (..._ids) => fii.DELETE(..._ids),
    PUT: PUT
  }
}

// TODO: put in some defaults
function TFIDF (ops) {
  const calculateScore = (x, _, resultSet) => {
    const idf = Math.log((global.D + 1) / resultSet.length);
    x._score = +x._match.reduce(
      (acc, cur) => acc + idf * +cur.split(':')[1], 0
    ).toFixed(2); // TODO: make precision an option
    return x
  };
  return ops
    .resultSet
    .map(calculateScore)
  // sort by score descending
    .sort((a, b) => b._score - a._score)
  // limit to n hits
    .slice(ops.offset, ops.limit)
}

// TODO: put in some defaults
function numericField (ops) {
  const calculateScore = (x) => {
    x._score = +x._match.filter(
      item => item.startsWith(ops.fieldName)
    )[0].split(':')[1];
    return x
  };
  return ops
    .resultSet
    .map(calculateScore)
  // sort by score descending
    .sort(ops.sort)
  // limit to n hits
    .slice(ops.offset, ops.limit)
}

function getAvailableFields (fii) {
  return getRange(fii, {
    gte: '￮FIELD￮',
    lte: '￮FIELD￮￮'
  }).then(fields => fields.map(field => field.split('￮')[2]))
}

function getRange (fii, q) {
  return new Promise((resolve, reject) => {
    var data = [];
    fii.STORE.createKeyStream(q)
      .on('data', d => data.push(d))
      .on('end', () => resolve(data));
  })
}

function reader (fii) {
  const flatten = arr => [].concat.apply([], arr);

  const flattenMatch = result => result.map(x => {
    x._match = flatten(x._match); // flatten
    x._match = flatten(x._match); // flatten again
    return x
  });

  const DICTIONARY = q => new Promise((resolve) => {
    // if query is string convert to object
    // if no query, make empty query
    q = Object.assign(
      { gte: '', lte: '￮' },
      (typeof q === 'string') ? { gte: q, lte: q + '￮' } : q
    );

    return resolve(
      new Promise(resolve => resolve(q.fields || getAvailableFields(fii)))
        .then(fields => Promise.all(
          fields.map(field => getRange(fii, {
            gte: field + '.' + q.gte,
            lte: field + '.' + q.lte + '￮'
          }))
        ))
        .then(flatten)
        .then(tokens => tokens.map(t => t.split(':')[0].split('.').pop()))
        .then(tokens => tokens.sort())
        .then(tokens => [...new Set(tokens)])
    )
  });

  const DOCUMENTS = requestedDocs => new Promise(
    resolve => fii.OBJECT(requestedDocs).then(
      retrievedDocs => resolve(requestedDocs.map((hit, i) => (Object.assign({
        _doc: retrievedDocs[i] ? retrievedDocs[i]['!doc'] : null
      }, requestedDocs[i]))))
    ));

  const AND = (...keys) => fii.AND(
    ...keys.map(fii.GET)
  ).then(flattenMatch);

  const SEARCH = (...q) => AND(...q)
    .then(resultSet => TFIDF({
      resultSet: resultSet,
      offset: 0,
      limit: 10
    }))
    .then(resultSet => DOCUMENTS(resultSet));

  const OR = (...q) => fii.OR(
    ...flatten(q.map(fii.GET))
  ).then(flattenMatch);

  // NOT
  const SET_DIFFERENCE = (a, b) => Promise.all([
    (typeof a === 'string') ? GET(a) : a,
    (typeof b === 'string') ? GET(b) : b
  ]).then(([a, b]) => a.filter(
    aItem => b.map(bItem => bItem._id).indexOf(aItem._id) === -1)
  );

  // const GET = clause => {
  //   return fii.GET(clause)
  //   // could be a nested AND/OR/something else
  //   if (clause instanceof Promise) return clause
  //   // ELSE wildcard (*) search
  //   if (clause.slice(-2) === ':*') return fii.GET(clause.replace(':*', '.'))
  //   // ELSE a clause with a specified field ("<fieldpath>:clause")
  //   if (clause.indexOf(':') > -1) return fii.GET(clause.replace(':', '.') + ':')
  //   // ELSE a clause without specified field ("clause")
  //   return OR(...global.searchableFields.map(f => f + ':' + clause))
  // }

  const DISTINCT = term => fii.DISTINCT(term).then(result => {
    return [...result.reduce((acc, cur) => {
      acc.add(cur.split(':')[0]);
      return acc
    }, new Set())]
  });

  // TODO: Tests for JSON nesting and JSON .then-ing
  // This function reads queries in a JSON format and then translates them to
  // Promises
  const parseJsonQuery = (...q) => {
    // needs to be called with "command" and result from previous "thenable"
    var promisifyQuery = (command, resultFromPreceding) => {
      if (typeof command === 'string') return GET(command)
      if (command.ALL) return Promise.all(
        // TODO: why cant this be "command.ALL.map(promisifyQuery)"?
        command.ALL.map(item => promisifyQuery(item))
      )
      if (command.AND) return AND(...command.AND.map(promisifyQuery))
      if (command.BUCKETFILTER) {
        return fii.BUCKETFILTER(
          Promise.all(command.BUCKETFILTER[0].map(promisifyQuery)),
          parseJsonQuery(command.BUCKETFILTER[1])
        )
      }
      // feed in preceding results if present (ie if not first promise)
      if (command.BUCKET) return fii.BUCKET(resultFromPreceding || command.BUCKET)
      if (command.DICTIONARY) return DICTIONARY(command.DICTIONARY)
      if (command.DISTINCT) return DISTINCT(command.DISTINCT)
      // feed in preceding results if present (ie if not first promise)
      if (command.DOCUMENTS) return DOCUMENTS(resultFromPreceding || command.DOCUMENTS)
      if (command.GET) return GET(command.GET)
      if (command.OR) return OR(...command.OR.map(promisifyQuery))
      if (command.NOT) {
        return SET_DIFFERENCE(
          promisifyQuery(command.NOT.include),
          promisifyQuery(command.NOT.exclude)
        )
      }
      if (command.SEARCH) return SEARCH(...command.SEARCH.map(promisifyQuery))
    };
    // Turn the array of commands into a chain of promises
    return q.reduce((acc, cur) => acc.then(
      result => promisifyQuery(cur, result)
    ), promisifyQuery(q.shift())) // <- Separate the first promise in the chain
    //    to be used as the start point in .reduce
  };

  return {
    AND: AND,
    BUCKET: fii.BUCKET,
    BUCKETFILTER: fii.BUCKETFILTER,
    DICTIONARY: DICTIONARY,
    DISTINCT: DISTINCT,
    DOCUMENTS: DOCUMENTS,
    GET: fii.GET,
    OR: OR,
    SCORENUMERIC: numericField,
    SCORETFIDF: TFIDF,
    SEARCH: SEARCH,
    SET_DIFFERENCE: SET_DIFFERENCE,
    parseJsonQuery: parseJsonQuery
  }
}

global.D = 0; // total docs in index
global.searchableFields = []; // fields that are available for searching

const makeASearchIndex = idx => {
  const w = writer(idx);
  const r = reader(idx);
  return {
    AND: r.AND,
    BUCKET: r.BUCKET,
    BUCKETFILTER: r.BUCKETFILTER,
    DELETE: w.DELETE,
    DICTIONARY: r.DICTIONARY,
    DISTINCT: r.DISTINCT,
    DOCUMENTS: r.DOCUMENTS,
    GET: r.GET,
    INDEX: idx,
    NOT: r.SET_DIFFERENCE,
    OR: r.OR,
    PUT: w.PUT,
    SCORENUMERIC: r.SCORENUMERIC,
    SCORETFIDF: r.SCORETFIDF,
    SEARCH: r.SEARCH,
    read: r.parseJsonQuery
  }
};

function main (ops) {
  return new Promise((resolve, reject) => {
    fii(ops, (err, idx) => {
      if (err) return reject(err)
      resolve(util(idx).calibrate()
        .then(() => {
          return makeASearchIndex(idx)
        }));
    });
  })
}

module.exports = main;
