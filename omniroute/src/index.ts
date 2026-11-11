import { loadConfig, type Loaded } from './config.ts';
import { Router } from './router.ts';
import { createGateway } from './server.ts';

let cfg: Loaded;
try {
  cfg = loadConfig(process.env.OMNIROUTE_CONFIG ?? 'omniroute.config.json', process.env);
} catch (e) {
  console.error(`omniroute: ${(e as Error).message}`);
  process.exit(1);
}
for (const w of cfg.warnings) console.warn(`omniroute: ${w}`);

const router = new Router(cfg.targets, cfg.options);
const server = createGateway(router, {
  token: cfg.token,
  log: (line) => console.log(new Date().toISOString(), line),
});
server.listen(cfg.port, cfg.host, () => {
  console.log(`omniroute: http://${cfg.host}:${cfg.port}/v1  model "omni"`);
  console.log(`omniroute: order ${cfg.targets.map((t) => t.name).join(' > ')}${cfg.token ? ' (token required)' : ''}`);
});
