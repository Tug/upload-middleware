var express = require('express')
  , upload_middleware = require('../index');

var app = express.createServer();

app.get('/', function(req, res) {
  res.send('<form method="post" enctype="multipart/form-data">'
    + '<p>File: <input type="file" name="file" /></p>'
    + '<p><input type="submit" value="Upload" /></p>'
    + '</form>');
});

app.post('/', upload_middleware.upload, function(req, res, next) {

  var fileinfo = req.form.fileInfo;
  var filesize = req.form.fileInfo.filesize;

  var out = require('fs').createWriteStream(fileinfo.filename);
  
  req.form.speedTarget = 20000;
  
  req.form.onChunk = function(data, callback) {
    out.write(data);
    callback();
  };
  
  req.form.on('end', function() {
    console.log('file end');
    out.end();
    res.send('ok');
  });
  
  req.form.on('error', function(error) {
    console.log(error);
  });

  req.form.on('aborted', function() {
    console.log("client has disconnected");
    // unlink file here
  });
  
  // simulate async operation here (read can also be called sync)
  setTimeout(function() {
    req.form.read();
  }, 500);
  
}, upload_middleware.errorHandler);

app.listen(3000);
console.log('Express app started on port 3000');


