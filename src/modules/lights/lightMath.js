// Pure helpers for the fork's Light actions. No I/O, so they're unit-tested
// directly (lightMath.test.js). Home Assistant state shapes follow the light
// entity's attributes: brightness 0–255, color_temp_kelvin, hs_color [h, s].

export const BRIGHTNESS_STEP_PCT = 5
export const KELVIN_STEP = 100
export const HUE_STEP = 10
const DEFAULT_MIN_KELVIN = 2000
const DEFAULT_MAX_KELVIN = 6500

const COLOR_MODES = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww']

export function isOn(state) {
  return state?.state === 'on'
}

export function supportedModes(state) {
  return state?.attributes?.supported_color_modes ?? []
}

export function supportsBrightness(state) {
  const modes = supportedModes(state)
  return modes.length > 0 && !(modes.length === 1 && modes[0] === 'onoff')
}

export function supportsColorTemp(state) {
  return supportedModes(state).includes('color_temp')
}

export function supportsColor(state) {
  return supportedModes(state).some((m) => COLOR_MODES.includes(m))
}

/** Current brightness as 0–100, or 0 when off. */
export function brightnessPct(state) {
  if (!isOn(state)) return 0
  const b = state.attributes?.brightness
  if (typeof b !== 'number') return 100
  return Math.round((b / 255) * 100)
}

/**
 * Next brightness for a dial turn. Turning up from off starts at one step;
 * turning below 1% means off (returns 0).
 */
export function nextBrightnessPct(currentPct, ticks, step = BRIGHTNESS_STEP_PCT) {
  const target = currentPct + ticks * step
  if (target <= 0) return 0
  return Math.min(100, Math.max(1, target))
}

export function kelvinRange(state) {
  const a = state?.attributes ?? {}
  const min = a.min_color_temp_kelvin ?? DEFAULT_MIN_KELVIN
  const max = a.max_color_temp_kelvin ?? DEFAULT_MAX_KELVIN
  return { min, max }
}

/** The light's colour temperature, or the middle of its range when it's in a colour mode. */
export function currentKelvin(state) {
  const k = state?.attributes?.color_temp_kelvin
  if (typeof k === 'number') return k
  const { min, max } = kelvinRange(state)
  return Math.round((min + max) / 2 / KELVIN_STEP) * KELVIN_STEP
}

export function nextKelvin(currentK, ticks, range, step = KELVIN_STEP) {
  return Math.min(range.max, Math.max(range.min, currentK + ticks * step))
}

/** Position of a kelvin value in the light's range, 0–100 (warm → cool). */
export function kelvinPct(k, range) {
  if (range.max <= range.min) return 0
  return Math.round(((k - range.min) / (range.max - range.min)) * 100)
}

/** Current hue and saturation. Coming from colour-temperature mode, use full saturation. */
export function currentHs(state) {
  const hs = state?.attributes?.hs_color
  const inTempMode = state?.attributes?.color_mode === 'color_temp'
  if (Array.isArray(hs) && hs.length === 2) {
    return { h: hs[0], s: inTempMode ? 100 : hs[1] }
  }
  return { h: 0, s: 100 }
}

export function nextHue(h, ticks, step = HUE_STEP) {
  return (((h + ticks * step) % 360) + 360) % 360
}

/** Approximate RGB for a colour temperature (Tanner Helland's fit), as #rrggbb. */
export function kelvinToHex(kelvin) {
  const t = kelvin / 100
  let r, g, b
  if (t <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(t) - 161.1195681661
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592)
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492)
    b = 255
  }
  return rgbToHex([r, g, b])
}

export function hsToHex(h, s) {
  // HSV with value 1.
  const sat = s / 100
  const c = sat
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = 1 - c
  let rgb
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return rgbToHex(rgb.map((v) => (v + m) * 255))
}

export function rgbToHex(rgb) {
  return (
    '#' +
    rgb
      .map((v) =>
        Math.round(Math.min(255, Math.max(0, v)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}

/** The colour a light is actually showing, for icons and bars. Grey when off. */
export function displayColor(state) {
  if (!isOn(state)) return '#5a5a5a'
  const a = state.attributes ?? {}
  if (a.color_mode === 'color_temp' && typeof a.color_temp_kelvin === 'number') {
    return kelvinToHex(a.color_temp_kelvin)
  }
  if (Array.isArray(a.rgb_color) && a.rgb_color.length === 3) {
    return rgbToHex(a.rgb_color)
  }
  if (Array.isArray(a.hs_color)) return hsToHex(a.hs_color[0], a.hs_color[1])
  return '#ffd27a'
}

/**
 * Merge a recent local change over the last state Home Assistant reported, so a
 * dial doesn't jump back while HA catches up. `override` is a partial attributes
 * object plus `state`; it applies until `until` (ms since epoch).
 */
export function withOverride(state, override, now = Date.now()) {
  if (!state || !override || override.until <= now) return state
  const attrs = { ...override }
  delete attrs.until
  delete attrs.state
  return {
    ...state,
    state: override.state ?? state.state,
    attributes: { ...state.attributes, ...attrs }
  }
}
