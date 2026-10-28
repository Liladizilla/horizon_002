export type EventType = 'circuit' | 'sprint' | 'dirt' | 'timetrial' | 'drift' | 'speedtrap' | 'jump';

export interface EventDef {
  id: string;
  name: string;
  type: EventType;
  description: string;
  /** Closed circuit on this road (repeat laps) or point-to-point between two roads. */
  roadId: string;
  /** For sprints: the road the route finishes on (graph path is computed). */
  toRoadId?: string;
  /** Fraction along the road where the route starts (0..1). */
  startFraction: number;
  /** Circuit length as a fraction of the road loop; sprints use 1. */
  lengthFraction: number;
  laps: number;
  checkpointSpacing: number;   // metres between gates
  rewardCredits: number;
  rewardXp: number;
  unlockLevel: number;
  /** Challenge-specific targets */
  targetTime?: number;
  targetScore?: number;
  targetSpeed?: number;
  targetDistance?: number;
  /** Where the event marker sits in the world (start gate). */
  location: { x: number; z: number; yaw: number };
}

export const EVENTS: EventDef[] = [
  {
    id: 'festival-circuit', name: 'Festival Circuit', type: 'circuit',
    description: 'Two laps of the festival loop. Fast, flowing, and a great place to learn the car.',
    roadId: 'festival-loop', startFraction: 0.0, lengthFraction: 1, laps: 2, checkpointSpacing: 110,
    rewardCredits: 18000, rewardXp: 900, unlockLevel: 1, targetTime: 105,
    location: { x: 80, z: 250, yaw: 0 },
  },
  {
    id: 'festival-sprint', name: 'Avenida Sprint', type: 'sprint',
    description: 'Point-to-point from the hub out to the farmland. Watch the crests.',
    roadId: 'town-link', toRoadId: 'farm-road', startFraction: 0.02, lengthFraction: 1, laps: 1, checkpointSpacing: 140,
    rewardCredits: 14000, rewardXp: 700, unlockLevel: 1, targetTime: 95,
    location: { x: 80, z: 250, yaw: 0 },
  },
  {
    id: 'coast-run', name: 'Costa Run', type: 'sprint',
    description: 'High-speed coastal highway blast. Top speed matters here.',
    roadId: 'coast-highway', toRoadId: 'mountain-pass', startFraction: 0.05, lengthFraction: 1, laps: 1, checkpointSpacing: 160,
    rewardCredits: 22000, rewardXp: 1100, unlockLevel: 2, targetTime: 150,
    location: { x: -560, z: 60, yaw: 0 },
  },
  {
    id: 'sierra-climb', name: 'Sierra Climb', type: 'sprint',
    description: 'Switchbacks up the mountain pass. Brake early, get on the power late.',
    roadId: 'mountain-pass', toRoadId: 'desert-highway', startFraction: 0.02, lengthFraction: 1, laps: 1, checkpointSpacing: 120,
    rewardCredits: 26000, rewardXp: 1400, unlockLevel: 3, targetTime: 175,
    location: { x: -700, z: -640, yaw: 0 },
  },
  {
    id: 'dune-highway', name: 'Dune Highway', type: 'sprint',
    description: 'Wide open desert tarmac with long sweepers and no room for error.',
    roadId: 'desert-highway', toRoadId: 'canyon-track', startFraction: 0.02, lengthFraction: 1, laps: 1, checkpointSpacing: 170,
    rewardCredits: 24000, rewardXp: 1200, unlockLevel: 3, targetTime: 165,
    location: { x: 1300, z: -1050, yaw: 0 },
  },
  {
    id: 'barro-rally', name: 'Barro Rally', type: 'dirt',
    description: 'Gravel loop around the rally field. Slide it, do not fight it.',
    roadId: 'rally-loop', startFraction: 0, lengthFraction: 1, laps: 3, checkpointSpacing: 90,
    rewardCredits: 30000, rewardXp: 1600, unlockLevel: 2, targetTime: 200,
    location: { x: 820, z: 830, yaw: 0 },
  },
  {
    id: 'selva-trail', name: 'Selva Trail', type: 'dirt',
    description: 'Dirt trail through the jungle with a river crossing. All-wheel drive helps.',
    roadId: 'jungle-trail', toRoadId: 'coast-highway', startFraction: 0.02, lengthFraction: 1, laps: 1, checkpointSpacing: 100,
    rewardCredits: 20000, rewardXp: 1000, unlockLevel: 2, targetTime: 140,
    location: { x: -700, z: -640, yaw: 0 },
  },
  {
    id: 'canyon-race', name: 'Cañón Gravel', type: 'dirt',
    description: 'Loose gravel through the canyon. Crests, drops and dust.',
    roadId: 'canyon-track', toRoadId: 'desert-highway', startFraction: 0.02, lengthFraction: 1, laps: 1, checkpointSpacing: 110,
    rewardCredits: 22000, rewardXp: 1100, unlockLevel: 3, targetTime: 130,
    location: { x: 1560, z: -300, yaw: 0 },
  },
  {
    id: 'time-attack', name: 'Time Attack', type: 'timetrial',
    description: 'Single car, single lap of the festival circuit. Beat the target time.',
    roadId: 'festival-loop', startFraction: 0, lengthFraction: 1, laps: 1, checkpointSpacing: 110,
    rewardCredits: 12000, rewardXp: 800, unlockLevel: 1, targetTime: 58,
    location: { x: 80, z: 250, yaw: 0 },
  },
  {
    id: 'drift-zone', name: 'Festival Drift Zone', type: 'drift',
    description: 'Score points by drifting through the zone. Speed and angle both count.',
    roadId: 'festival-loop', startFraction: 0.34, lengthFraction: 0.16, laps: 1, checkpointSpacing: 60,
    rewardCredits: 15000, rewardXp: 900, unlockLevel: 1, targetScore: 12000,
    location: { x: 660, z: -180, yaw: 0 },
  },
  {
    id: 'speed-trap', name: 'Costa Speed Trap', type: 'speedtrap',
    description: 'Hit the trap as fast as you can. You only get a flying run.',
    roadId: 'coast-highway', startFraction: 0.32, lengthFraction: 0.08, laps: 1, checkpointSpacing: 80,
    rewardCredits: 16000, rewardXp: 900, unlockLevel: 2, targetSpeed: 250,
    location: { x: -1520, z: 60, yaw: 0 },
  },
  {
    id: 'canyon-jump', name: 'Canyon Jump', type: 'jump',
    description: 'Launch off the canyon crest. Distance measured from take-off to landing.',
    roadId: 'canyon-track', startFraction: 0.42, lengthFraction: 0.1, laps: 1, checkpointSpacing: 60,
    rewardCredits: 16000, rewardXp: 900, unlockLevel: 2, targetDistance: 55,
    location: { x: 1680, z: -860, yaw: 0 },
  },
];

export const EVENT_BY_ID: Record<string, EventDef> = Object.fromEntries(EVENTS.map((e) => [e.id, e]));
