// Preloaded into the server under test (node --import) so that nothing it does can reach the
// network: an id that wrongly passes the path check fails here instead of calling the live API.
import net from 'node:net';
import tls from 'node:tls';

const refuse = () => {
  throw new Error('network disabled in tests');
};
net.connect = refuse;
net.createConnection = refuse;
tls.connect = refuse;
