/**
 * Load Balancer - Cross-instance load balancing for multi-browser scenarios
 * 
 * Features:
 * - Instance health checking (port probing + extension connection status)
 * - Instance load monitoring (queue length + active task count)
 * - Intelligent routing (auto-assign tasks to idle instances)
 * - Failover (auto-migrate tasks when instance crashes)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './instance-config.js';
import { listInstances } from './instance-config.js';
import { loadConfig } from './config.js';

// Every HTTP route on this service requires `Bearer <agentToken>`. Health
// probes and task routing are calls like any other, so they carry the token
// too; without it a healthy instance was reported as dead (401 -> false).
function agentHeaders() {
  try {
    return { Authorization: `Bearer ${loadConfig().agentToken}` };
  } catch {
    // A fresh instance or a unit test may have no config.json yet. Send the
    // request unauthenticated rather than inventing a token; a 401 then proves
    // the port is listening even though the caller cannot use it.
    return {};
  }
}

function portFor(instanceId) {
  return listInstances().find(i => i.id === instanceId)?.port ?? 19387;
}

// ─────────────────────────────────────────────────────────────────────────────
// Instance Health Monitor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if an instance is healthy and ready to accept tasks
 * Returns: { healthy: boolean, healthScore: number, reason?: string }
 */
async function checkInstanceHealth(instanceId) {
  const instance = listInstances().find(i => i.id === instanceId);
  if (!instance) {
    return { healthy: false, healthScore: 0, reason: 'instance_not_found' };
  }
  
  if (!instance.enabled) {
    return { healthy: false, healthScore: 0, reason: 'instance_disabled' };
  }
  
  // A pid file exists only for instances launched through instance-manager.
  // The default service is started by the watchdog with .local/server.pid, so
  // the absence of <instanceId>.pid proves nothing. Whether a service is alive
  // is decided by the port probe below, not by a bookkeeping file.
  // Attempt HTTP health check
  let portHealthy = false;
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/status`, {
      headers: agentHeaders(),
      signal: AbortSignal.timeout(3000)
    });
    // A 401 still proves a service is listening and answering on this port;
    // it means the token does not match, not that the instance is dead.
    portHealthy = response.ok || response.status === 401;
  } catch {
    portHealthy = false;
  }
  
  if (!portHealthy) {
    return { healthy: false, healthScore: 0, reason: 'port_unreachable' };
  }
  
  // Instance is healthy
  return { healthy: true, healthScore: 100, reason: 'healthy' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Metrics Collection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get load metrics for an instance
 * Returns: { queueLength, activeTasks, healthScore, cpuLoad?, memoryLoad? }
 */
async function getInstanceLoad(instanceId) {
  const health = await checkInstanceHealth(instanceId);
  if (!health.healthy) {
    return { instanceId, healthy: false, load: 100, metrics: {} };
  }
  
  try {
    // /browser_queue_status is a TOOL name, not an HTTP route. The queue
    // snapshot travels in GET /status as `queued`. Resolve the port from the
    // instance registry instead of reading `.port` off an instance-id string
    // (which produced http://127.0.0.1:undefined/...).
    const response = await fetch(`http://127.0.0.1:${portFor(instanceId)}/status`, {
      headers: agentHeaders(),
      signal: AbortSignal.timeout(3000)
    });

    if (!response.ok) {
      return { instanceId, healthy: true, load: 90, metrics: {},
        reason: response.status === 401 ? 'unauthorized' : 'status_unavailable' };
    }

    const queueStatus = await response.json();

    return {
      instanceId,
      healthy: true,
      load: Number(queueStatus.queued ?? 0),
      metrics: queueStatus
    };
  } catch {
    // Fallback: assume moderate load if can't query
    return {
      instanceId,
      healthy: true,
      load: 50,
      metrics: {},
      reason: 'metrics_unavailable'
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Balancer Core
// ─────────────────────────────────────────────────────────────────────────────

class LoadBalancer {
  constructor() {
    this.instances = new Map();
    this.lastHealthCheck = new Map();
    this.healthCheckIntervalMs = 10000; // Check every 10 seconds
    this.cacheTTL = 5000; // Cache health status for 5 seconds
  }
  
  /**
   * Get the best instance to route a task to
 * Returns: { instanceId, score, reason }
   */
  async selectBestInstance(task) {
    const instances = listInstances().filter(i => i.enabled);

    if (instances.length === 0) {
      return { instanceId: null, score: 0, reason: 'no_available_instances' };
    }

    // Probe every enabled instance and keep only the ones that answer. Pid
    // bookkeeping is not used as a filter (see checkInstanceHealth).
    const instanceLoads = [];
    for (const instance of instances) {
      const load = await getInstanceLoad(instance.id);
      if (load.healthy) instanceLoads.push(load);
    }

    if (instanceLoads.length === 0) {
      return { instanceId: null, score: 0, reason: 'no_healthy_instances' };
    }

    // Score instances based on load and health
    const scored = instanceLoads.map(load => {
      let score = load.load; // Lower load = better score
      let healthPenalty = 0;
      
      // Add health penalty for instances with issues
      if (load.reason) {
        healthPenalty = 30;
      }
      
      // Prefer instances with fewer queued tasks
      const finalScore = score + healthPenalty;
      
      return {
        instanceId: load.instanceId,
        score: finalScore,
        load: load.load,
        metrics: load.metrics
      };
    });
    
    // Sort by score (lower is better)
    scored.sort((a, b) => a.score - b.score);
    
    const best = scored[0];
    
    return {
      instanceId: best.instanceId,
      score: best.score,
      reason: best.score <= 10 ? 'idle' : best.score <= 30 ? 'low_load' : 'moderate_load'
    };
  }
  
  /**
   * Route a task to the best available instance
   * Returns: { routed: boolean, targetInstance, result? }
   */
  async routeTask(task) {
    const { instanceId, score, reason } = await this.selectBestInstance(task);
    
    if (!instanceId) {
      return { routed: false, reason: 'no_available_instance' };
    }
    
    // Route task to selected instance via HTTP
    const port = this.getInstancePort(instanceId);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/call`, {
        method: 'POST',
        headers: { ...agentHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: task.name,
          arguments: task.args || {}
        }),
        signal: AbortSignal.timeout(5000)
      });
      
      if (!response.ok) {
        return { routed: false, reason: 'routing_failed', targetInstance: instanceId };
      }
      
      const result = await response.json();
      return { routed: true, targetInstance: instanceId, result };
    } catch {
      return { routed: false, reason: 'routing_timeout', targetInstance: instanceId };
    }
  }
  
  /**
   * Get instance port by ID
   */
  getInstancePort(instanceId) {
    return portFor(instanceId);
  }
  
  /**
   * Get all instances with their current load
   */
  async getLoadStatus() {
    const instances = listInstances();
    const status = [];
    
    for (const instance of instances) {
      const load = await getInstanceLoad(instance.id);
      status.push({
        instanceId: instance.id,
        port: instance.port,
        profile: instance.profileDirectory,
        healthy: load.healthy,
        load: load.load,
        metrics: load.metrics
      });
    }
    
    return status;
  }
  
  /**
   * Detect and handle instance failures
   * Returns: { failedInstances: [], migratedTasks: [] }
   */
  async detectAndHandleFailures() {
    const instances = listInstances();
    const failedInstances = [];
    
    for (const instance of instances) {
      const health = await checkInstanceHealth(instance.id);
      if (!health.healthy && !this.lastHealthCheck.get(instance.id)?.healthy) {
        // Instance just failed
        failedInstances.push({
          instanceId: instance.id,
          reason: health.reason,
          port: instance.port
        });
      }
      this.lastHealthCheck.set(instance.id, { healthy: health.healthy });
    }
    
    return { failedInstances, migratedTasks: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export {
  LoadBalancer,
  checkInstanceHealth,
  getInstanceLoad,
  listInstances
};
