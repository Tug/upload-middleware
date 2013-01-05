var formidable = require('formidable');
var Stream = require('stream').Stream;
var EventEmitter = require("events").EventEmitter;

module.exports.upload = function(req, res, next) {
  if(req.headers['content-type'].match(/multipart/i)) {
    multipart(req, res, next);
  } else if(req.headers['content-type'].match(/octet-stream/i)) {
    octetStream(req, res, next);
  } else {
    next(new Error("Request neither a multipart/form-data not an octet-stream"));
    return;
  }
  req.on('end', function() {
    if(!res.headerSent) res.send(JSON.stringify({success: true}));
  });
}


var octetStream = module.exports.octetStream = function(req, res, next) {
  
  var controls = req.form = new EventEmitter;
  
  var fileInfo = controls.fileInfo = {
    filename: decodeURIComponent(req.header('x-file-name')),
    filesize: parseInt(req.header('content-length'), 10)
  };
  
  controlRequestStream(req, req, controls);
  req.pause();
  next();
  
}


var multipart = module.exports.multipart = function(req, res, next) {
  
  var form = req.form = new formidable.IncomingForm;
  
  var fileInfo = req.form.fileInfo = {};
  
  // save fields in form.fileInfo
  form.on('field', function(name, value) {
    fileInfo[name] = value;
  });
  
  // overriding form onPart function
  form.onPart = function(part) {
    if(!part.filename) { // processing fields
      form.handlePart(part);
    } else {             // processing file
      fileInfo.filename = part.filename;
      fileInfo.filesize = parseInt(fileInfo.filesize, 10);
      // in case the file is uploaded with a flash client
      // or any other clients which cannot send the cookie in the header
      // (user needs to parse cookie and retrieve sessionid himself)
      if(fileInfo.cookie) {
        req.headers.cookie = fileInfo.cookie;
      }
      
      controlRequestStream(req, part, form);
      
      // once the parser has done parsing the boudary data
      // we can estimate the file size and call the next req action
      part.once('data', function(data) {
        var remainingSize = form.bytesExpected - form._parser.partDataMark;
        var boundaryEndSize = form._parser.boundary.length + 4;
        var filesize = remainingSize - boundaryEndSize;
        // if the filesize has been sent in a separate field
        // check if it's consistent
        if(fileInfo.filesize) {
          if(Math.abs(fileInfo.filesize - filesize) > 1000) { // 1KB difference allowed
            next(new Error('Size is larger than expected'));
            return;
          }
        } else { // otherwise creates the filesize field 
                 // max size check should be done by the user before calling start()
          fileInfo.filesize = filesize;
        }
        req.pause();
        next();
      });
    }
  };
  
  // let's parse the form
  form.parse(req, function(err) {});
  
};

/*
 * req is an HTTP request stream
 * dataEmitter is the data emitter which is processing the request (for instance the output of a multipart parser)
 * controls is an object which allows to receive chunks asynchronously and control the upload speed.
 */
function controlRequestStream(req, dataEmitter, controls) {
  
  controls = controls || new EventEmitter;

  controls.currentSpeed = 0;      // should be read only
  controls.uploaded     = 0;      // should be read only
  controls.speedTarget  = 20000;  // 20 MB/s
  // rewrite this function to receive data chunks
  controls.onChunk      = function(data, callback) {};
  
  // bufferize first chunks
  var chunks = [];
  var dataBufferedHandler = function(chunk) {
    chunks.push(chunk);
  };
  
  var processingChunks = false;
  var end = false;
  function dataEventHandler() {
    if(!processingChunks) {
      processingChunks = true;
      req.pause();
      processChunk(function() {
        processingChunks = false;
        req.resume();
        if(end) {
          controls.emit('close');
        }
      });
    }
  }

  function endEventHandler() {
    end = true;
  }
  
  dataEmitter.on('data', dataBufferedHandler);
  dataEmitter.on('data', statHandler());
  dataEmitter.on('error', function(err) { controls.emit('error', err); });
  dataEmitter.on('aborted', function() { controls.emit('aborted'); });
  dataEmitter.on('end', endEventHandler);
  
  controls.read = function(callback) {
    req.resume();
    dataEmitter.on('data', dataEventHandler);
    
    // it is important to start now otherwise it won't emit
    // buffered chunks if there are no more data to receive
    if(chunks.length > 0) {
      dataEventHandler();
    }    
  }
  
  // live stats on data
  function statHandler() {    
    var lastTime = Date.now();
    var dtMean = 100, chunkSizeMean = 40900;
    return function(chunk) {
      var bytesReceived = chunk.length;
      chunkSizeMean = 0.9 * chunkSizeMean + 0.1 * bytesReceived;
      var now = Date.now();
      dtMean = 0.9 * dtMean + 0.1 * (now - lastTime + 1);
      lastTime = now;
      controls.currentSpeed = chunkSizeMean / dtMean;
      controls.uploaded += bytesReceived;
    };
  }
  
  // waits enough time for the upload to run at req.speedTarget
  // the wait delay should be auto-adaptative
  var dtCorrMean = 0;
  function wait(bytesReceived, callback) {
    var speedTarget = controls.speedTarget;
    var chunkDelay = bytesReceived/ speedTarget; // B  /  B/ms  =  ms
    var currentSpeed = controls.currentSpeed;
    var speedDiff = (1 - currentSpeed/speedTarget);
    var dtCorrection = chunkDelay * speedDiff;
    chunkDelay -= dtCorrection + dtCorrMean;
    dtCorrMean = 0.9 * dtCorrMean + 0.1 * dtCorrection
    if(chunkDelay < 1) chunkDelay = 0;
    if(chunkDelay > 3000) chunkDelay = 3000; // 3 sec for 40k = 12kb/s
    setTimeout(callback, chunkDelay);
  }
  
  // read next chunk in the chunks array
  // and pass it to form.onChunk
  function processChunk(callback) {
    (function nextChunk() {
      if(chunks.length == 0) callback();
      else {
        var chunk = chunks.shift();
        controls.onChunk(chunk, function() {
          wait(chunk.length, nextChunk);
        });
      }
    })();
  }

  return controls;

}


module.exports.errorHandler = function(err, req, res, next) {
  req.resume();
  res.writeHead(500, { 'Content-Type': 'text/html' });
  res.end(JSON.stringify({success: false, error: err.message}));
};


