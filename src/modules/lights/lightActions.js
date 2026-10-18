// Fork: purpose-built light controls. Four actions that know a light's real
// state, instead of the generic "call any service with a template" action:
//
//   Light        (key)  press toggles; icon shows the light's actual colour and
//                       brightness, grey when off.
//   Brightness   (dial) ±5% per click from the real brightness; press toggles.
//   Temperature  (dial) ±100 K per click within the bulb's range; press toggles.
//   Colour       (dial) ±10° hue per click; press toggles.
//
// Settings per action: { entityIds: string[], label: string }. A dial or key may
// drive several lights; it displays the first one. PluginComponent hands every
// event for these action UUIDs to this module and doesn't touch them otherwise.

import { mdiLightbulb, mdiLightbulbOutline } from '@mdi/js'
import {
  brightnessPct,
  currentHs,
  currentKelvin,
  displayColor,
  hsToHex,
  isOn,
  kelvinPct,
  kelvinRange,
  kelvinToHex,
  nextBrightnessPct,
  nextHue,
  nextKelvin,
  supportsColor,
  supportsColorTemp,
  withOverride
} from './lightMath.js'

const PREFIX = 'de.perdoctus.streamdeck.homeassistant.'
export const LIGHT_ACTIONS = {
  toggle: PREFIX + 'light',
  brightness: PREFIX + 'light-brightness',
  temperature: PREFIX + 'light-temperature',
  color: PREFIX + 'light-color'
}
const KIND_BY_UUID = Object.fromEntries(Object.entries(LIGHT_ACTIONS).map(([k, v]) => [v, k]))

const SEND_INTERVAL_MS = 150
const OVERRIDE_MS = 2000
const SIZE = 288

function settingsOf(raw) {
  const ids = Array.isArray(raw?.entityIds) ? raw.entityIds.filter(Boolean) : []
  return { entityIds: ids, label: typeof raw?.label === 'string' ? raw.label : '' }
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export class LightActions {
  #getSD
  #getHA
  #svgToImage
  #contexts = new Map() // context -> { kind, settings }
  #states = new Map() // entity_id -> HA state object
  #overrides = new Map() // entity_id -> override (see withOverride)
  #pending = new Map() // context -> { domain, service, data }
  #timers = new Map() // context -> timeout id
  #unsubscribe = null
  #generation = 0

  constructor(getSD, getHA, svgToImage) {
    this.#getSD = getSD
    this.#getHA = getHA
    this.#svgToImage = svgToImage
  }

  owns(action) {
    return action in KIND_BY_UUID
  }

  handle(event, message) {
    const { context } = message
    switch (event) {
      case 'willAppear':
      case 'didReceiveSettings': {
        const kind = KIND_BY_UUID[message.action]
        this.#contexts.set(context, { kind, settings: settingsOf(message.payload?.settings) })
        if (kind !== 'toggle') this.#getSD()?.setFeedbackLayout(context, { layout: '$B1' })
        this.#resubscribe()
        this.#render(context)
        break
      }
      case 'willDisappear':
        this.#contexts.delete(context)
        clearTimeout(this.#timers.get(context))
        this.#timers.delete(context)
        this.#pending.delete(context)
        this.#resubscribe()
        break
      case 'keyUp':
      case 'dialDown':
      case 'touchTap':
        this.#toggle(context)
        break
      case 'dialRotate':
        this.#rotate(context, message.payload?.ticks ?? 0)
        break
      default:
        break
    }
  }

  onConnected() {
    this.#resubscribe()
  }

  onDisconnected() {
    this.#unsubscribe = null
    for (const context of this.#contexts.keys()) this.#render(context)
  }

  // --- state -------------------------------------------------------------

  #allEntityIds() {
    const ids = new Set()
    for (const { settings } of this.#contexts.values())
      settings.entityIds.forEach((id) => ids.add(id))
    return [...ids]
  }

  async #resubscribe() {
    const ha = this.#getHA()
    if (!ha) return
    const generation = ++this.#generation
    if (this.#unsubscribe) {
      const unsub = this.#unsubscribe
      this.#unsubscribe = null
      try {
        await unsub()
      } catch {
        // connection may already be gone
      }
    }
    const ids = this.#allEntityIds()
    if (ids.length === 0) return

    ha.getStates((states) => {
      for (const s of states) if (ids.includes(s.entity_id)) this.#states.set(s.entity_id, s)
      this.#renderAll()
    })

    let unsub = null
    try {
      unsub = await ha.subscribeEntitiesChanged(ids, (event) => {
        const s = event?.variables?.trigger?.to_state
        if (!s?.entity_id) return
        this.#states.set(s.entity_id, s)
        this.#renderEntity(s.entity_id)
      })
    } catch (e) {
      console.log(`Light actions: failed to subscribe: ${e}`)
      return
    }
    if (generation !== this.#generation) {
      try {
        await unsub?.()
      } catch {
        // ignore
      }
      return
    }
    this.#unsubscribe = unsub
  }

  #displayState(entityId) {
    return withOverride(this.#states.get(entityId), this.#overrides.get(entityId))
  }

  // --- input ---------------------------------------------------------------

  #toggle(context) {
    const entry = this.#contexts.get(context)
    if (!entry || entry.settings.entityIds.length === 0) return this.#getSD()?.showAlert(context)
    const primary = this.#displayState(entry.settings.entityIds[0])
    const turningOn = !isOn(primary)
    this.#setOverride(entry.settings.entityIds, { state: turningOn ? 'on' : 'off' })
    this.#call(context, { domain: 'light', service: 'toggle', data: {} }, true)
  }

  #rotate(context, ticks) {
    const entry = this.#contexts.get(context)
    if (!entry || ticks === 0) return
    const ids = entry.settings.entityIds
    if (ids.length === 0) return this.#getSD()?.showAlert(context)
    const state = this.#displayState(ids[0])
    if (!state) return this.#getSD()?.showAlert(context)

    if (entry.kind === 'brightness') {
      const pct = nextBrightnessPct(brightnessPct(state), ticks)
      if (pct === 0) {
        this.#setOverride(ids, { state: 'off' })
        this.#call(context, { domain: 'light', service: 'turn_off', data: {} })
      } else {
        this.#setOverride(ids, { state: 'on', brightness: Math.round(pct * 2.55) })
        this.#call(context, { domain: 'light', service: 'turn_on', data: { brightness_pct: pct } })
      }
    } else if (entry.kind === 'temperature') {
      if (!supportsColorTemp(state)) return this.#getSD()?.showAlert(context)
      const k = nextKelvin(currentKelvin(state), ticks, kelvinRange(state))
      this.#setOverride(ids, { state: 'on', color_mode: 'color_temp', color_temp_kelvin: k })
      this.#call(context, { domain: 'light', service: 'turn_on', data: { color_temp_kelvin: k } })
    } else if (entry.kind === 'color') {
      if (!supportsColor(state)) return this.#getSD()?.showAlert(context)
      const { h, s } = currentHs(state)
      const hue = nextHue(h, ticks)
      this.#setOverride(ids, { state: 'on', color_mode: 'hs', hs_color: [hue, s], rgb_color: null })
      this.#call(context, { domain: 'light', service: 'turn_on', data: { hs_color: [hue, s] } })
    }
  }

  #setOverride(ids, attrs) {
    const until = Date.now() + OVERRIDE_MS
    for (const id of ids) {
      const previous = this.#overrides.get(id)
      const base = previous && previous.until > Date.now() ? previous : {}
      this.#overrides.set(id, { ...base, ...attrs, until })
      this.#renderEntity(id)
    }
  }

  // Sends now if nothing is in flight for this context, otherwise keeps only the
  // latest request and sends it when the interval ends. Toggles always go now.
  #call(context, request, immediate = false) {
    this.#pending.set(context, request)
    if (immediate) {
      clearTimeout(this.#timers.get(context))
      this.#timers.delete(context)
      this.#flush(context)
      return
    }
    if (this.#timers.has(context)) return
    this.#flush(context)
    this.#timers.set(
      context,
      setTimeout(() => {
        this.#timers.delete(context)
        if (this.#pending.has(context)) this.#flush(context)
      }, SEND_INTERVAL_MS)
    )
  }

  #flush(context) {
    const request = this.#pending.get(context)
    this.#pending.delete(context)
    const entry = this.#contexts.get(context)
    const ha = this.#getHA()
    if (!request || !entry || !ha) return
    const ids = entry.settings.entityIds
    ha.callService(
      request.domain,
      request.service,
      ids.length === 1 ? ids[0] : ids,
      request.data
    ).catch((e) => {
      console.error(e)
      this.#getSD()?.showAlert(context)
    })
  }

  // --- output --------------------------------------------------------------

  #renderAll() {
    for (const context of this.#contexts.keys()) this.#render(context)
  }

  #renderEntity(entityId) {
    for (const [context, { settings }] of this.#contexts) {
      if (settings.entityIds[0] === entityId) this.#render(context)
    }
  }

  #title(entry, state) {
    if (entry.settings.label) return entry.settings.label
    const name = state?.attributes?.friendly_name ?? entry.settings.entityIds[0] ?? 'Pick a light'
    const extra =
      entry.settings.entityIds.length > 1 ? ` +${entry.settings.entityIds.length - 1}` : ''
    return name + extra
  }

  async #render(context) {
    const sd = this.#getSD()
    const entry = this.#contexts.get(context)
    if (!sd || !entry) return
    const state = entry.settings.entityIds.length
      ? this.#displayState(entry.settings.entityIds[0])
      : null

    if (entry.kind === 'toggle') {
      const image = await this.#svgToImage(this.#keySvg(entry, state))
      if (!this.#contexts.has(context)) return
      sd.setTitle(context, '')
      sd.setImage(context, image)
      return
    }
    sd.setFeedback(context, this.#dialFeedback(entry, state))
  }

  #keySvg(entry, state) {
    const on = isOn(state)
    const color = state ? displayColor(state) : '#5a5a5a'
    const pct = brightnessPct(state)
    const path = on ? mdiLightbulb : mdiLightbulbOutline
    const label = this.#title(entry, state)
    const short = label.length > 14 ? label.slice(0, 13) + '…' : label
    const glow = on ? `<circle cx="144" cy="112" r="92" fill="${color}" opacity="0.18"/>` : ''
    const bar = on
      ? `<rect x="24" y="262" width="240" height="10" rx="5" fill="#333"/>` +
        `<rect x="24" y="262" width="${Math.max(10, (240 * pct) / 100)}" height="10" rx="5" fill="${color}"/>`
      : ''
    const status = !state ? (entry.settings.entityIds.length ? '…' : 'Pick a light') : ''
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
      `<rect width="${SIZE}" height="${SIZE}" fill="#000"/>` +
      glow +
      `<g transform="translate(72 40) scale(6)"><path d="${on ? path : mdiLightbulbOutline}" fill="${color}"/></g>` +
      `<text x="144" y="${on ? 244 : 254}" fill="#fff" font-family="Arial, sans-serif" font-size="34" text-anchor="middle">${escapeXml(status || short)}</text>` +
      bar +
      `</svg>`
    )
  }

  #dialFeedback(entry, state) {
    const title = this.#title(entry, state)
    if (!state) {
      return {
        title,
        value: entry.settings.entityIds.length ? '…' : 'Pick a light',
        indicator: { value: 0 }
      }
    }
    if (entry.kind === 'brightness') {
      const pct = brightnessPct(state)
      return {
        title,
        value: isOn(state) ? `${pct}%` : 'Off',
        indicator: { value: pct, bar_fill_c: displayColor(state) }
      }
    }
    if (entry.kind === 'temperature') {
      if (!supportsColorTemp(state))
        return { title, value: 'No white temp', indicator: { value: 0 } }
      const range = kelvinRange(state)
      const k = currentKelvin(state)
      const inTemp = state.attributes?.color_mode === 'color_temp'
      return {
        title,
        value: !isOn(state) ? `Off · ${k} K` : inTemp ? `${k} K` : `Colour · ${k} K`,
        indicator: { value: kelvinPct(k, range), bar_fill_c: kelvinToHex(k) }
      }
    }
    // colour
    if (!supportsColor(state)) return { title, value: 'No colour', indicator: { value: 0 } }
    const { h } = currentHs(state)
    const inColor = state.attributes?.color_mode !== 'color_temp'
    return {
      title,
      value: !isOn(state) ? 'Off' : inColor ? `${Math.round(h)}°` : 'White',
      indicator: { value: Math.round((h / 360) * 100), bar_fill_c: hsToHex(h, 100) }
    }
  }
}
