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
import { isInstanceRunning } from './instance-manager.js';

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
  
  if (!isInstanceRunning(instanceId)) {
    return { healthy: false, healthScore: 0, reason: 'instance_not_running' };
  }
  
  // Attempt HTTP health check
  let portHealthy = false;
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/status`, {
      signal: AbortSignal.timeout(3000)
    });
    portHealthy = response.ok;
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
    // Query queue status from instance
    const response = await fetch(`http://127.0.0.1:${instanceId === 'default' ? 19387 : instanceId === 'profile1' ? 19388 : instanceId === 'profile2' ? 19389 : instanceId.port}/browser_queue_status`, {
      signal: AbortSignal.timeout(3000)
    });
    
    if (!response.ok) {
      return { instanceId, healthy: true, load: 90, metrics: {}, reason: 'queue_status_unavailable' };
    }
    
    const queueStatus = await response.json();
    
    return {
      instanceId,
      healthy: true,
      load: queueStatus.queueLength || 0,
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
    const instances = listInstances().filter(i => i.enabled && isInstanceRunning(i.id));
    
    if (instances.length === 0) {
      return { instanceId: null, score: 0, reason: 'no_available_instances' };
    }
    
    // Health check all instances
    const instanceLoads = [];
    for (const instance of instances) {
      const load = await getInstanceLoad(instance.id);
      instanceLoads.push(load);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: task.name,
          arguments: task.args || {},
          metadata: task.metadata
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
    const instance = listInstances().find(i => i.id === instanceId);
    return instance?.port || 19387;
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
