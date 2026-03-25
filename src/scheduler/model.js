export const WEATHER_KINDS = [
  'wind',
  'rain',
  'mist',
  'washdown',
  'fogBuildup',
  'fogClearing',
]

export const INTENT_KINDS = [
  'clock-reveal',
  'reminder-draw',
  'message-draw',
  'social-icon-reveal',
]

export const REGION_IDS = ['global', 'q1', 'q2', 'q3', 'q4']

export function createZeroWeatherState() {
  return {
    wind: 0,
    rain: 0,
    mist: 0,
    washdown: 0,
    fogBuildup: 0,
    fogClearing: 0,
  }
}
