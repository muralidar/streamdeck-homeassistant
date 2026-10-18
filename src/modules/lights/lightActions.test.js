import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LIGHT_ACTIONS, LightActions } from './lightActions.js'

function fakeSD() {
  return {
    images: [],
    feedback: [],
    alerts: [],
    layouts: [],
    setImage(context, image) {
      this.images.push({ context, image })
    },
    setTitle() {},
    setFeedback(context, payload) {
      this.feedback.push({ context, payload })
    },
    setFeedbackLayout(context, payload) {
      this.layouts.push({ context, payload })
    },
    showAlert(context) {
      this.alerts.push(context)
    }
  }
}

function fakeHA(states) {
  return {
    calls: [],
    subscribed: null,
    getStates(cb) {
      cb(states)
    },
    async subscribeEntitiesChanged(ids, cb) {
      this.subscribed = { ids, cb }
      return async () => {}
    },
    callService(domain, service, target, data) {
      this.calls.push({ domain, service, target, data })
      return Promise.resolve()
    }
  }
}

const study = {
  entity_id: 'light.study_overhead',
  state: 'on',
  attributes: {
    friendly_name: 'Study Overhead',
    brightness: 128,
    color_mode: 'color_temp',
    color_temp_kelvin: 3000,
    hs_color: [30, 40],
    supported_color_modes: ['color_temp', 'hs'],
    min_color_temp_kelvin: 2200,
    max_color_temp_kelvin: 6500
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('LightActions', () => {
  let sd, ha, lights
  beforeEach(() => {
    vi.useRealTimers()
    sd = fakeSD()
    ha = fakeHA([study, { entity_id: 'switch.other', state: 'on', attributes: {} }])
    lights = new LightActions(
      () => sd,
      () => ha,
      async (svg) => 'data:image/svg+xml,' + svg
    )
  })

  const appear = (context, kind, entityIds = ['light.study_overhead']) =>
    lights.handle('willAppear', {
      context,
      action: LIGHT_ACTIONS[kind],
      payload: { settings: { entityIds } }
    })

  it('owns only its own action UUIDs', () => {
    expect(lights.owns(LIGHT_ACTIONS.brightness)).toBe(true)
    expect(lights.owns('de.perdoctus.streamdeck.homeassistant.entity')).toBe(false)
  })

  it('subscribes to the configured lights and renders the key with the light’s name', async () => {
    appear('k1', 'toggle')
    await flush()
    expect(ha.subscribed.ids).toEqual(['light.study_overhead'])
    const last = sd.images.at(-1)
    expect(last.context).toBe('k1')
    expect(last.image).toContain('Study Overhead')
  })

  it('toggles on key up, not key down', async () => {
    appear('k1', 'toggle')
    await flush()
    lights.handle('keyDown', { context: 'k1', action: LIGHT_ACTIONS.toggle })
    expect(ha.calls).toHaveLength(0)
    lights.handle('keyUp', { context: 'k1', action: LIGHT_ACTIONS.toggle })
    expect(ha.calls).toEqual([
      { domain: 'light', service: 'toggle', target: 'light.study_overhead', data: {} }
    ])
  })

  it('brightness dial steps from the real brightness and shows it', async () => {
    appear('d1', 'brightness')
    await flush()
    expect(sd.layouts.at(-1).payload.layout).toBe('$B1')
    lights.handle('dialRotate', {
      context: 'd1',
      action: LIGHT_ACTIONS.brightness,
      payload: { ticks: 2 }
    })
    expect(ha.calls.at(-1)).toEqual({
      domain: 'light',
      service: 'turn_on',
      target: 'light.study_overhead',
      data: { brightness_pct: 60 }
    })
    expect(sd.feedback.at(-1).payload.value).toBe('60%')
  })

  it('throttles fast turns to one call per interval and sends the latest value', async () => {
    vi.useFakeTimers()
    appear('d1', 'brightness')
    await vi.runOnlyPendingTimersAsync()
    for (let i = 0; i < 5; i++) {
      lights.handle('dialRotate', {
        context: 'd1',
        action: LIGHT_ACTIONS.brightness,
        payload: { ticks: 1 }
      })
    }
    expect(ha.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(ha.calls).toHaveLength(2)
    expect(ha.calls.at(-1).data).toEqual({ brightness_pct: 75 })
    vi.useRealTimers()
  })

  it('temperature dial steps 100 K within the bulb’s range', async () => {
    appear('d2', 'temperature')
    await flush()
    lights.handle('dialRotate', {
      context: 'd2',
      action: LIGHT_ACTIONS.temperature,
      payload: { ticks: -9 }
    })
    expect(ha.calls.at(-1).data).toEqual({ color_temp_kelvin: 2200 })
    expect(sd.feedback.at(-1).payload.value).toBe('2200 K')
  })

  it('colour dial starts at full saturation when the light is white', async () => {
    appear('d3', 'color')
    await flush()
    lights.handle('dialRotate', {
      context: 'd3',
      action: LIGHT_ACTIONS.color,
      payload: { ticks: 3 }
    })
    expect(ha.calls.at(-1).data).toEqual({ hs_color: [60, 100] })
  })

  it('sends one call to several lights at once', async () => {
    appear('d1', 'brightness', ['light.study_overhead', 'light.study_lamp'])
    await flush()
    lights.handle('dialRotate', {
      context: 'd1',
      action: LIGHT_ACTIONS.brightness,
      payload: { ticks: 1 }
    })
    expect(ha.calls.at(-1).target).toEqual(['light.study_overhead', 'light.study_lamp'])
  })

  it('alerts instead of calling when no light is picked or the bulb lacks the feature', async () => {
    appear('d4', 'temperature', [])
    lights.handle('dialRotate', {
      context: 'd4',
      action: LIGHT_ACTIONS.temperature,
      payload: { ticks: 1 }
    })
    expect(sd.alerts).toContain('d4')
    expect(ha.calls).toHaveLength(0)
  })

  it('follows state changes pushed by Home Assistant', async () => {
    appear('d1', 'brightness')
    await flush()
    ha.subscribed.cb({
      variables: {
        trigger: { to_state: { ...study, attributes: { ...study.attributes, brightness: 255 } } }
      }
    })
    expect(sd.feedback.at(-1).payload.value).toBe('100%')
  })
})
