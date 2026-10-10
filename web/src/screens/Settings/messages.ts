/** What each refusal from the box means, in words. */
const MESSAGES: Record<string, string> = {
  'wrong-admin-password': "That box password wasn't accepted. It's the password for the box itself, not for your WiFi.",
  'wrong-wifi-password': "That WiFi password wasn't accepted. Check it and try again.",
  'no-such-network': 'The box can’t see that network. Check the name, and that the box is near enough to your router.',
  'needs-admin-password': 'This box needs its own password the first time it’s set up.',
  'bootstrap-failed': 'The box couldn’t give itself permission to change networks. Send this message on.',
  'bootstrap-incomplete': 'The box couldn’t give itself permission to change networks. Send this message on.',
  'no-ssid': 'Choose a network, or type its name.',
  'last-network': 'That’s the only network this box can reach, so it won’t forget it. Add another one first.',
  'too-short': 'That’s too short — a WiFi password needs at least 8 characters.',
  'too-long': 'That’s too long for a WiFi password (63 characters maximum).',
  'unsupported-characters': 'Use plain letters, numbers and punctuation — anything else can’t be typed back in reliably.',
  'no-password': 'Enter a password.',
  unreachable: 'The box stopped answering. If you were changing networks, it may have moved.',
};

export function messageFor(reason: string, detail?: string): string {
  return MESSAGES[reason]
    ?? `That didn’t work — ${detail ?? reason}. Send this message on.`;
}
