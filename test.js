const { getStreams } = require('./providers/moviesdrive.js');

getStreams('66732', 'tv',1,1).then(streams => {
  console.log('Found', streams.length, 'streams');
  streams.forEach(stream => console.log(`${stream.name}: ${stream.quality}`));
}).catch(console.error);