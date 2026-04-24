import { createApp } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

const { server } = await createApp();

server.listen(port, () => {
  console.log(`WeChat binding plugin listening on port ${port}`);
});
