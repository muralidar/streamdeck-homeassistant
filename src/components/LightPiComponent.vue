<template>
  <div class="lp">
    <section class="lp-section">
      <div class="lp-head">
        <span class="lp-title">{{ kindTitle }}</span>
        <span :class="['lp-status', `lp-status--${haState}`]">{{ statusText }}</span>
      </div>
      <p class="lp-hint">{{ kindHint }}</p>
    </section>

    <section class="lp-section">
      <label class="lp-label" for="lp-filter">Lights</label>
      <input id="lp-filter" v-model="filter" class="lp-input" placeholder="Filter by name" />
      <div v-if="haState !== 'connected'" class="lp-empty">
        {{
          haState === 'connecting'
            ? 'Connecting to Home Assistant…'
            : 'Connect to Home Assistant below to list your lights.'
        }}
      </div>
      <div v-else-if="visibleLights.length === 0" class="lp-empty">No lights match.</div>
      <div v-else class="lp-list">
        <label v-for="light in visibleLights" :key="light.id" class="lp-row">
          <input
            type="checkbox"
            :checked="entityIds.includes(light.id)"
            @change="toggleEntity(light.id)"
          />
          <span class="lp-row-name">{{ light.name }}</span>
          <span class="lp-row-id">{{ light.id }}</span>
        </label>
      </div>
      <p class="lp-hint">
        Pick one or more. Several lights move together; the display follows the first one picked.
      </p>
    </section>

    <section class="lp-section">
      <label class="lp-label" for="lp-label">Label</label>
      <input
        id="lp-label"
        v-model="label"
        class="lp-input"
        placeholder="Defaults to the light's name"
        @change="save"
      />
    </section>

    <section class="lp-section">
      <details :open="haState !== 'connected'">
        <summary class="lp-label">Home Assistant connection</summary>
        <p class="lp-hint">
          Shared by every Home Assistant key. Use a non-admin user's long-lived token.
        </p>
        <label class="lp-label" for="lp-server">Server URL</label>
        <input
          id="lp-server"
          v-model="serverUrl"
          class="lp-input"
          placeholder="http://homeassistant.local:8123"
        />
        <label class="lp-label" for="lp-token">Access token</label>
        <input
          id="lp-token"
          v-model="accessToken"
          class="lp-input"
          type="password"
          autocomplete="off"
        />
        <button class="lp-button" @click="saveConnection">Save and connect</button>
        <p v-if="haError" class="lp-error">{{ haError }}</p>
      </details>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { StreamDeck } from '@/modules/common/streamdeck'
import { GlobalSettings } from '@/modules/common/settings'
import { Homeassistant } from '@/modules/homeassistant/homeassistant'

const KINDS = {
  'de.perdoctus.streamdeck.homeassistant.light': {
    title: 'Light',
    hint: 'Press to toggle. The key shows the light’s colour and brightness.'
  },
  'de.perdoctus.streamdeck.homeassistant.light-brightness': {
    title: 'Brightness dial',
    hint: 'Turn: 5% per click. Press or tap: toggle.'
  },
  'de.perdoctus.streamdeck.homeassistant.light-temperature': {
    title: 'Colour temperature dial',
    hint: 'Turn: 100 K per click, within what the bulb supports. Press or tap: toggle.'
  },
  'de.perdoctus.streamdeck.homeassistant.light-color': {
    title: 'Colour dial',
    hint: 'Turn: 10° of hue per click. Press or tap: toggle.'
  }
}

let $SD = null
let $HA = null
let globalSettings = {}

const action = ref('')
const entityIds = ref([])
const label = ref('')
const filter = ref('')
const lights = ref([])
const serverUrl = ref('')
const accessToken = ref('')
const haState = ref('disconnected')
const haError = ref('')

const kindTitle = computed(() => KINDS[action.value]?.title ?? 'Light')
const kindHint = computed(() => KINDS[action.value]?.hint ?? '')
const statusText = computed(
  () =>
    ({ connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected' })[
      haState.value
    ]
)
const visibleLights = computed(() => {
  const f = filter.value.trim().toLowerCase()
  const list = f
    ? lights.value.filter((l) => l.name.toLowerCase().includes(f) || l.id.includes(f))
    : lights.value
  // Selected lights first, in the order they were picked.
  return [
    ...entityIds.value.map((id) => list.find((l) => l.id === id)).filter(Boolean),
    ...list.filter((l) => !entityIds.value.includes(l.id))
  ]
})

function save() {
  $SD?.saveSettings({ entityIds: entityIds.value, label: label.value })
}

function toggleEntity(id) {
  entityIds.value = entityIds.value.includes(id)
    ? entityIds.value.filter((e) => e !== id)
    : [...entityIds.value, id]
  save()
}

function connect() {
  $HA?.close()
  $HA = null
  if (!serverUrl.value || !accessToken.value) {
    haState.value = 'disconnected'
    return
  }
  haState.value = 'connecting'
  haError.value = ''
  $HA = new Homeassistant(
    serverUrl.value,
    accessToken.value,
    () => {
      haState.value = 'connected'
      $HA.getStates((states) => {
        lights.value = states
          .filter((s) => s.entity_id.startsWith('light.'))
          .map((s) => ({ id: s.entity_id, name: s.attributes?.friendly_name || s.entity_id }))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      })
    },
    (message) => {
      haState.value = 'disconnected'
      haError.value = message
    },
    () => {
      haState.value = 'disconnected'
    }
  )
}

function saveConnection() {
  globalSettings = {
    ...globalSettings,
    serverUrl: serverUrl.value.trim(),
    accessToken: accessToken.value.trim()
  }
  $SD?.saveGlobalSettings(globalSettings)
  connect()
}

onMounted(() => {
  window.connectElgatoStreamDeckSocket = (
    inPort,
    inUUID,
    inRegisterEvent,
    inInfo,
    inActionInfo
  ) => {
    $SD = new StreamDeck(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo)
    const info = JSON.parse(inActionInfo)
    action.value = info.action
    const settings = info.payload?.settings ?? {}
    entityIds.value = Array.isArray(settings.entityIds) ? settings.entityIds : []
    label.value = typeof settings.label === 'string' ? settings.label : ''

    $SD.on('globalsettings', (gs) => {
      globalSettings = GlobalSettings.migrate(gs ?? {}) ?? {}
      serverUrl.value = globalSettings.serverUrl ?? ''
      accessToken.value = globalSettings.accessToken ?? ''
      connect()
    })
    $SD.on('connected', () => $SD.requestGlobalSettings())
  }
})
</script>

<style scoped>
.lp {
  padding: 8px 10px 16px;
  color: var(--pi-text-primary);
  font-size: 12px;
}
.lp-section {
  margin-bottom: 14px;
}
.lp-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.lp-title {
  font-weight: 500;
  font-size: 13px;
}
.lp-status {
  font-size: 11px;
  color: var(--pi-text-muted);
}
.lp-status--connected {
  color: var(--pi-success);
}
.lp-status--connecting {
  color: var(--pi-warning);
}
.lp-hint {
  color: var(--pi-text-secondary);
  margin: 4px 0 0;
  line-height: 1.4;
}
.lp-label {
  display: block;
  color: var(--pi-text-secondary);
  margin: 8px 0 4px;
  cursor: pointer;
}
.lp-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--pi-bg-sunken);
  color: var(--pi-text-primary);
  border: 1px solid var(--pi-border-strong);
  border-radius: var(--pi-radius);
  padding: 6px 8px;
  font-size: 12px;
}
.lp-list {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--pi-border);
  border-radius: var(--pi-radius);
  margin-top: 6px;
}
.lp-row {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 8px;
  align-items: center;
  padding: 5px 8px;
  border-bottom: 1px solid var(--pi-border);
  cursor: pointer;
}
.lp-row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lp-row-id {
  grid-column: 2;
  color: var(--pi-text-muted);
  font-size: 10px;
}
.lp-empty {
  color: var(--pi-text-muted);
  padding: 8px 0;
}
.lp-button {
  margin-top: 10px;
  background: var(--pi-accent-dim);
  color: var(--pi-accent);
  border: 1px solid var(--pi-accent);
  border-radius: var(--pi-radius);
  padding: 6px 10px;
  cursor: pointer;
}
.lp-error {
  color: var(--pi-danger);
  margin-top: 6px;
}
</style>
