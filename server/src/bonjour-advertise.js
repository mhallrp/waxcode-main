import { Bonjour } from 'bonjour-service';
import { hostname, networkInterfaces } from 'node:os';

// Custom type rather than plain "http", so a client sees only Waxcode boxes.
const SERVICE_TYPE = 'pidvs';

// Defaults to the box's hostname, not a fixed literal
export function advertise(port, { name = hostname() } = {}) {
  // Pinned explicitly to wlan0's address - when a phone is docked with Personal Hotspot on, eth1's route outranks wlan0's
  const wlanAddress = (networkInterfaces().wlan0 ?? []).find((i) => i.family === 'IPv4')?.address;

  const bonjour = new Bonjour(wlanAddress ? { interface: wlanAddress } : undefined);
  const service = bonjour.publish({ name, type: SERVICE_TYPE, port });

  return {
    service,
    stop: () => new Promise((resolve) => {
      bonjour.unpublishAll(() => {
        bonjour.destroy();
        resolve();
      });
    }),
  };
}
