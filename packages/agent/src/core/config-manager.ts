import type { FSWatcher } from 'fs';
import os from 'os';
import { AGENT_DEFAULTS, CONFIG_FILE } from './config.js';
import { ConfigStorage } from './config-storage.js';
import { parseEditableValue, type ConfigFieldKey } from './config-field-definitions.js';

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export interface ServerConfig {
  blockedCommands?: string[];
  defaultShell?: string;
  allowedDirectories?: string[];
  telemetryEnabled?: boolean; // New field for telemetry control
  fileWriteLineLimit?: number; // Line limit for file write operations
  fileReadLineLimit?: number; // Default line limit for file read operations (changed from character-based)
  clientId?: string; // Unique client identifier for analytics
  currentClient?: ClientInfo; // Current connected client information
  [key: string]: any; // Allow for arbitrary configuration keys (including abTest_* keys)
}

export interface ClientInfo {
  name: string;
  version: string;
}

export function normalizeTelemetryEnabledValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  return value;
}

export function isTelemetryDisabledValue(value: unknown): boolean {
  return normalizeTelemetryEnabledValue(value) === false;
}

/**
 * Singleton config manager for the server
 */
class ConfigManager {
  private storage = new ConfigStorage(CONFIG_FILE);
  private config: ServerConfig = {};
  private initialized = false;
  private _isFirstRun = false; // Track if this is the first run (config was just created)
  // Serializes all disk writes so concurrent saves can't corrupt config.json.
  private writeChain: Promise<void> = Promise.resolve();
  // True while a coalesced background write is already queued (see scheduleSave).
  private saveScheduled = false;
  private pendingMutations: Array<(config: ServerConfig) => void> = [];
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;


  /**
   * Initialize configuration - load from disk or create default.
   * Creation and legacy migration use the same cross-process mutation path as
   * normal writes so two processes starting together cannot clobber each other.
   */
  async init() {
    if (this.initialized) return;

    await this.storage.prepare();
    let exists = true;
    try {
      this.config = await this.storage.read();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      exists = false;
    }
    if (!exists) {
      let created = false;
      await this.performConfigMutation((latest, existed) => {
        if (!existed) {
          Object.assign(latest, this.getDefaultConfig());
          created = true;
        }
      });
      this._isFirstRun = created;
    } else {
      this._isFirstRun = false;
      if (this.config['welcomeOnboardingEligible'] === undefined) {
        await this.performConfigMutation((latest) => {
          if (latest['welcomeOnboardingEligible'] === undefined) {
            latest['welcomeOnboardingEligible'] = false;
            latest['pendingWelcomeOnboarding'] = false;
          }
        });
      }
    }
    delete this.config.version;
    this.initialized = true;
    this.startConfigWatcher();
  }

  /**
   * Alias for init() to maintain backward compatibility
   */
  async loadConfig() {
    return this.init();
  }

  /**
   * Create default configuration
   */
  private getDefaultConfig(): ServerConfig {
    return {
      blockedCommands: [

        // Disk and partition management
        "mkfs",      // Create a filesystem on a device
        "format",    // Format a storage device (cross-platform)
        "mount",     // Mount a filesystem
        "umount",    // Unmount a filesystem
        "fdisk",     // Manipulate disk partition tables
        "dd",        // Convert and copy files, can write directly to disks
        "parted",    // Disk partition manipulator
        "diskpart",  // Windows disk partitioning utility
        
        // System administration and user management
        "sudo",      // Execute command as superuser
        "su",        // Substitute user identity
        "passwd",    // Change user password
        "adduser",   // Add a user to the system
        "useradd",   // Create a new user
        "usermod",   // Modify user account
        "groupadd",  // Create a new group
        "chsh",      // Change login shell
        "visudo",    // Edit the sudoers file
        
        // System control
        "shutdown",  // Shutdown the system
        "reboot",    // Restart the system
        "halt",      // Stop the system
        "poweroff",  // Power off the system
        "init",      // Change system runlevel
        
        // Network and security
        "iptables",  // Linux firewall administration
        "firewall",  // Generic firewall command
        "netsh",     // Windows network configuration
        
        // Windows system commands
        "sfc",       // System File Checker
        "bcdedit",   // Boot Configuration Data editor
        "reg",       // Windows registry editor
        "net",       // Network/user/service management
        "sc",        // Service Control manager
        "runas",     // Execute command as another user
        "cipher",    // Encrypt/decrypt files or wipe data
        "takeown"    // Take ownership of files
      ],
      defaultShell: (() => {
        if (os.platform() === 'win32') {
          return 'powershell.exe';
        }
        // Use user's actual shell from environment
        // On macOS, default to zsh (default since Catalina) since process.env.SHELL
        // may not be set when running inside Claude Desktop
        const fallbackShell = os.platform() === 'darwin' ? '/bin/zsh' : '/bin/sh';
        const userShell = process.env.SHELL || fallbackShell;
        // Return just the shell path - we'll handle login shell flag elsewhere
        return userShell;
      })(),
      allowedDirectories: [],
      telemetryEnabled: false, // Better Remote Commander (BRC): off by default
      fileWriteLineLimit: AGENT_DEFAULTS.fileWriteLineLimit,
      fileReadLineLimit: AGENT_DEFAULTS.fileReadLineLimit,
      pendingWelcomeOnboarding: true, // New install flag - triggers A/B test for welcome page
      welcomeOnboardingEligible: true // Distinguishes new installs from migrated legacy configs
    };
  }

  private async performConfigMutation(
    mutate: (config: ServerConfig, existed: boolean) => void
  ): Promise<ServerConfig> {
    const release = await this.storage.lock();
    try {
      let latest: ServerConfig;
      let existed = true;
      try {
        latest = await this.storage.read();
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
        latest = {};
        existed = false;
      }
      mutate(latest, existed);
      await this.storage.write(latest);
      delete latest.version;
      this.config = clone(latest);
      return latest;
    } finally {
      try {
        await release();
      } catch (error) {
        // The atomic rename is the commit boundary. A release failure after it
        // must not make callers replay a mutation that already persisted.
        console.error('Failed to release config lock:', error);
      }
    }
  }

  private queueMutation(mutate: (config: ServerConfig) => void): void {
    this.pendingMutations.push(mutate);
    this.scheduleSave();
  }

  /** Non-blocking, coalesced persistence for high-frequency state updates. */
  scheduleSave(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    const write = this.writeChain.then(async () => {
      this.saveScheduled = false;
      const mutations = this.pendingMutations.splice(0);
      if (mutations.length === 0) return;
      try {
        await this.performConfigMutation((latest) => {
          for (const mutate of mutations) mutate(latest);
        });
      } catch (error) {
        // Persistence failed before commit, so keep these mutations for a later retry.
        this.pendingMutations.unshift(...mutations);
        console.error('Failed to save config (background), will retry:', error);
        const retry = setTimeout(() => this.scheduleSave(), 250);
        retry.unref?.();
      }
    });
    this.writeChain = write.catch(() => {});
  }

  private startConfigWatcher(): void {
    if (this.watcher) return;
    try {
      this.watcher = this.storage.watch(() => {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.reloadConfigFromDisk(), 20);
      });
      this.watcher.on('error', (error) => console.error('Config watcher error:', error));
    } catch (error) {
      console.error('Failed to watch config:', error);
    }
  }

  private async reloadConfigFromDisk(): Promise<void> {
    try {
      const latest = await this.storage.read();
      for (const mutate of this.pendingMutations) mutate(latest);
      delete latest.version;
      this.config = latest;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error('Failed to reload config:', error);
    }
  }

  /**
   * Get the entire config
   */
  async getConfig(): Promise<ServerConfig> {
    await this.init();
    return clone(this.config);
  }

  /**
   * Get a specific configuration value
   */
  async getValue(key: string): Promise<any> {
    await this.init();
    return clone(this.config[key]);
  }

  async setUserSetting(key: ConfigFieldKey, raw: unknown): Promise<void> {
    await this.setValue(key, parseEditableValue(key, raw));
  }

  /** Set a specific configuration value and wait for durable persistence. */
  async setValue(key: string, value: any): Promise<void> {
    await this.init();
    if (key === 'telemetryEnabled') value = normalizeTelemetryEnabledValue(value);

    if (key === 'telemetryEnabled' && isTelemetryDisabledValue(value)) {
      const currentValue: unknown = this.config[key];
      if (!isTelemetryDisabledValue(currentValue)) {
        const { capture } = await import('./utils/capture.js');
        await capture('server_telemetry_opt_out', { reason: 'user_disabled', prev_value: currentValue });
      }
    }

    const nextValue = clone(value);
    const write = this.writeChain.then(() => this.performConfigMutation((latest) => {
      latest[key] = nextValue;
    }));
    this.writeChain = write.then(() => {}, () => {});
    await write;
  }

  /** Update one value under the cross-process lock and return the durable value. */
  async updateValue(key: string, updater: (current: any) => any): Promise<any> {
    await this.init();
    let updatedValue: any;
    const write = this.writeChain.then(() => this.performConfigMutation((latest) => {
      updatedValue = updater(clone(latest[key]));
      latest[key] = clone(updatedValue);
    }));
    this.writeChain = write.then(() => {}, () => {});
    await write;
    return clone(updatedValue);
  }

  /**
   * Set a value without waiting on disk. The queued operation is applied to the
   * latest on-disk config while holding the cross-process lock.
   */
  async setValueNonBlocking(key: string, value: any): Promise<void> {
    await this.init();
    const nextValue = clone(value);
    this.config[key] = nextValue;
    this.queueMutation((latest) => { latest[key] = nextValue; });
  }

  /**
   * Atomically update one value without blocking the caller on persistence.
   * The updater is replayed against the latest disk value under the lock, which
   * makes counter-style updates safe across multiple Desktop Commander processes.
   */
  async updateValueNonBlocking(key: string, updater: (current: any) => any): Promise<any> {
    await this.init();
    const next = updater(clone(this.config[key]));
    this.config[key] = clone(next);
    this.queueMutation((latest) => { latest[key] = updater(clone(latest[key])); });
    return clone(next);
  }

  /** Update multiple configuration values at once. */
  async updateConfig(updates: Partial<ServerConfig>): Promise<ServerConfig> {
    await this.init();
    const safeUpdates = clone(updates);
    const write = this.writeChain.then(() => this.performConfigMutation((latest) => {
      Object.assign(latest, safeUpdates);
    }));
    this.writeChain = write.then(() => {}, () => {});
    return clone(await write);
  }

  /** Reset configuration to defaults. This intentionally replaces all keys. */
  async resetConfig(): Promise<ServerConfig> {
    await this.init();
    const defaults = this.getDefaultConfig();
    const write = this.writeChain.then(() => this.performConfigMutation((latest) => {
      for (const key of Object.keys(latest)) delete latest[key];
      Object.assign(latest, defaults);
    }));
    this.writeChain = write.then(() => {}, () => {});
    return clone(await write);
  }

  /**
   * Check if this is the first run (config file was just created)
   */
  isFirstRun(): boolean {
    return this._isFirstRun;
  }

  /**
   * Get or create a persistent client ID for analytics and A/B tests
   */
  async getOrCreateClientId(): Promise<string> {
    const { randomUUID } = await import('crypto');
    return await this.updateValue('clientId', (current) => current || randomUUID());
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
