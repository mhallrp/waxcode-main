/** What the box's own setup network is called. */
export function setupSsid(serial: string | null | undefined): string {
  return serial ? `Waxcode Setup ${serial.slice(-4).toUpperCase()}` : 'Waxcode Setup';
}
