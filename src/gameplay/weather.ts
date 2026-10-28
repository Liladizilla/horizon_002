import { clamp, damp, lerp } from '../core/math';
import type { WeatherKind } from '../core/types';

export interface WeatherState {
  hour: number;         // 0..24
  day: number;
  weather: WeatherKind;
  wetness: number;
  fogDensity: number;
  windX: number;
  windZ: number;
  windSpeed: number;
  temperatureC: number;
  isNight: boolean;
  lightning: number;    // 0..1 flash intensity
}

/**
 * Time-of-day and weather.
 *
 * Weather changes on a slow random walk with smooth transitions; `wetness` is
 * the physical number the tyre model reads, and it rises during rain and dries
 * out slowly afterwards, so wet grip lags behind the sky.
 */
export class WeatherSystem {
  hour = 9.5;
  day = 1;
  weather: WeatherKind = 'clear';
  private targetWeather: WeatherKind = 'clear';
  wetness = 0;
  private targetWetness = 0;
  private changeTimer = 90;
  windX = 0; windZ = 0;
  windSpeed = 3;
  private targetWind = 3;
  lightning = 0;
  private lightningTimer = 4;
  /** game hours per real minute */
  timeScale = 1;
  locked: WeatherKind | 'auto' = 'auto';
  timeLock: number | null = null;
  seed = 12345;

  constructor(private rnd: () => number = Math.random) {}

  setLocked(kind: WeatherKind | 'auto') { this.locked = kind; }
  setTimeLock(hour: number | null) { this.timeLock = hour; }

  update(dt: number) {
    if (this.timeLock === null) {
      // 1 game hour per real minute at timeScale = 1.
      this.hour += (dt / 60) * this.timeScale;
      while (this.hour >= 24) { this.hour -= 24; this.day++; }
    } else {
      this.hour = this.timeLock;
    }

    this.changeTimer -= dt;
    if (this.locked !== 'auto') {
      this.targetWeather = this.locked;
    } else if (this.changeTimer <= 0) {
      this.changeTimer = 110 + this.rnd() * 180;
      const options: WeatherKind[] = ['clear', 'clear', 'overcast', 'rain', 'rain', 'storm', 'fog', 'sandstorm'];
      // Sandstorms belong to the desert; snow to the mountains - the caller can
      // bias these, but a gentle random walk is enough for the vertical slice.
      this.targetWeather = options[Math.floor(this.rnd() * options.length)];
      if (this.targetWeather === 'snow') this.targetWeather = 'overcast';
    }

    // Transition toward the target weather.
    const rate = this.targetWeather === 'rain' || this.targetWeather === 'storm' ? 0.22 : 0.09;
    if (this.weather !== this.targetWeather) {
      // Once the sky has decided, adopt it immediately and let wetness lag.
      this.weather = this.targetWeather;
    }
    this.targetWetness = this.weather === 'rain' ? 0.75 : this.weather === 'storm' ? 1 : this.weather === 'snow' ? 0.35 : 0;
    this.wetness = damp(this.wetness, this.targetWetness, this.targetWetness > this.wetness ? rate : 0.04, dt);
    this.wetness = clamp(this.wetness, 0, 1);

    this.targetWind = this.weather === 'storm' ? 12 : this.weather === 'sandstorm' ? 15 : this.weather === 'rain' ? 7 : 3;
    this.windSpeed = damp(this.windSpeed, this.targetWind, 0.3, dt);
    const windAngle = Math.sin(this.hour * 0.3 + this.day) * 1.2;
    this.windX = Math.sin(windAngle) * this.windSpeed;
    this.windZ = Math.cos(windAngle) * this.windSpeed;

    if (this.weather === 'storm') {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 3 + this.rnd() * 7;
        this.lightning = 1;
      }
      this.lightning = Math.max(0, this.lightning - dt * 3.2);
    } else this.lightning = Math.max(0, this.lightning - dt * 6);
  }

  get isNight() { return this.hour < 6.2 || this.hour > 19.4; }

  get state(): WeatherState {
    return {
      hour: this.hour, day: this.day, weather: this.weather, wetness: this.wetness,
      fogDensity: this.weather === 'fog' ? 1 : this.weather === 'storm' ? 0.7 : this.weather === 'rain' ? 0.4 : 0,
      windX: this.windX, windZ: this.windZ, windSpeed: this.windSpeed,
      temperatureC: lerp(30, 8, clamp((this.hour - 6) / 18, 0, 1)) - (this.weather === 'rain' ? 5 : 0),
      isNight: this.isNight,
      lightning: this.lightning,
    };
  }

  get label(): string {
    const names: Record<WeatherKind, string> = {
      clear: 'Clear', overcast: 'Overcast', rain: 'Rain', storm: 'Thunderstorm',
      fog: 'Fog', sandstorm: 'Sandstorm', snow: 'Snow',
    };
    return names[this.weather];
  }

  clockText(): string {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
