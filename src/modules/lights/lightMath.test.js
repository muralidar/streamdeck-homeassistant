import { describe, expect, it } from 'vitest'
import {
  brightnessPct,
  currentHs,
  currentKelvin,
  displayColor,
  hsToHex,
  kelvinPct,
  kelvinToHex,
  nextBrightnessPct,
  nextHue,
  nextKelvin,
  supportsBrightness,
  supportsColor,
  supportsColorTemp,
  withOverride
} from './lightMath.js'

const rgbLight = (attrs = {}, state = 'on') => ({
  entity_id: 'light.study',
  state,
  attributes: {
    supported_color_modes: ['color_temp', 'hs'],
    min_color_temp_kelvin: 2200,
    max_color_temp_kelvin: 6500,
    ...attrs
  }
})

describe('brightness', () => {
  it('reads 0–255 as a percentage and 0 when off', () => {
    expect(brightnessPct(rgbLight({ brightness: 128 }))).toBe(50)
    expect(brightnessPct(rgbLight({ brightness: 255 }, 'off'))).toBe(0)
  })
  it('steps 5% per tick, clamps at 100, and goes off below 1', () => {
    expect(nextBrightnessPct(50, 2)).toBe(60)
    expect(nextBrightnessPct(98, 3)).toBe(100)
    expect(nextBrightnessPct(5, -1)).toBe(0)
    expect(nextBrightnessPct(0, 1)).toBe(5)
  })
})

describe('colour temperature', () => {
  it('uses the light’s kelvin, or the middle of its range in colour mode', () => {
    expect(currentKelvin(rgbLight({ color_temp_kelvin: 3000 }))).toBe(3000)
    expect(currentKelvin(rgbLight({ color_temp_kelvin: null }))).toBe(4400)
  })
  it('steps 100 K per tick within the bulb’s range', () => {
    const range = { min: 2200, max: 6500 }
    expect(nextKelvin(3000, 3, range)).toBe(3300)
    expect(nextKelvin(2300, -5, range)).toBe(2200)
    expect(nextKelvin(6400, 5, range)).toBe(6500)
    expect(kelvinPct(4350, range)).toBe(50)
  })
  it('maps warm to orange-ish and cool to blue-ish', () => {
    const warm = kelvinToHex(2200)
    const cool = kelvinToHex(6500)
    expect(parseInt(warm.slice(5, 7), 16)).toBeLessThan(parseInt(cool.slice(5, 7), 16))
  })
})

describe('hue', () => {
  it('wraps around 360', () => {
    expect(nextHue(350, 2)).toBe(10)
    expect(nextHue(5, -1)).toBe(355)
  })
  it('switches to full saturation when coming from white', () => {
    expect(currentHs(rgbLight({ color_mode: 'color_temp', hs_color: [30, 40] }))).toEqual({
      h: 30,
      s: 100
    })
    expect(currentHs(rgbLight({ color_mode: 'hs', hs_color: [200, 60] }))).toEqual({
      h: 200,
      s: 60
    })
  })
  it('converts hue to hex', () => {
    expect(hsToHex(0, 100)).toBe('#ff0000')
    expect(hsToHex(120, 100)).toBe('#00ff00')
  })
})

describe('support and display', () => {
  it('detects what a bulb can do', () => {
    expect(supportsColorTemp(rgbLight())).toBe(true)
    expect(supportsColor(rgbLight())).toBe(true)
    const onoff = { state: 'on', attributes: { supported_color_modes: ['onoff'] } }
    expect(supportsBrightness(onoff)).toBe(false)
    expect(supportsColor(onoff)).toBe(false)
  })
  it('is grey when off and shows the real colour when on', () => {
    expect(displayColor(rgbLight({}, 'off'))).toBe('#5a5a5a')
    expect(displayColor(rgbLight({ color_mode: 'hs', rgb_color: [255, 0, 0] }))).toBe('#ff0000')
  })
  it('applies a local override until it expires', () => {
    const s = rgbLight({ brightness: 50 })
    expect(withOverride(s, { brightness: 200, until: 2000 }, 1000).attributes.brightness).toBe(200)
    expect(withOverride(s, { brightness: 200, until: 2000 }, 3000).attributes.brightness).toBe(50)
  })
})
