import { getPriority } from 'node:os';

/** Nice values are absolute here, unlike `nice -n`, which is a delta. */
const ONDEMAND_NICE = 15;

function niceDeltaTo(target, readPriority) {
  let current = 0;
  try {
    current = readPriority();
  } catch {
    /** Unavailable on some platforms; 0 means the delta is the target */
  }
  return String(target - current);
}

/** `readPriority` is injectable so a test can be the real box, which runs at Nice=-10. */
/** Spawns an analysis command at the OS priority that suits whoever is waiting on it. */
export function prioritizedSpawn(spawnFn, command, args, priority, options, readPriority = getPriority) {
  switch (priority) {
    case 'background':
      return spawnFn('nice', ['-n', niceDeltaTo(19, readPriority), 'ionice', '-c', '3', 'taskset', '-c', '3', command, ...args], options);
    case 'ondemand':
      return spawnFn('nice', ['-n', niceDeltaTo(ONDEMAND_NICE, readPriority), 'ionice', '-c', '2', '-n', '0', command, ...args], options);
    default:
      return spawnFn(command, args, options);
  }
}
