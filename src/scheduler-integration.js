/**
 * Scheduler Integration Layer
 * 
 * Wraps the existing queue system with intelligent scheduling capabilities:
 * - Priority engine enhancement
 * - AI-assisted task assessment
 * - Cross-instance load balancing
 * - Conflict detection
 * 
 * This layer is backwards compatible with the existing queue system.
 */
import { randomUUID } from 'node:crypto';
import { PriorityQueue, calculatePriority, decomposeTask } from './priority-engine.js';
import { LoadBalancer } from './load-balancer.js';
import { AIScheduler } from './ai-scheduler.js';

/**
 * Create an enhanced scheduler that wraps the existing queue
 */
function createScheduler(config = {}) {
  const priorityQueue = new PriorityQueue(config.maxQueueSize || 32);
  const loadBalancer = new LoadBalancer();
  const aiScheduler = new AIScheduler();
  
  let instanceMode = config.instanceMode || false;
  let currentInstanceId = config.currentInstanceId || 'default';
  
  /**
   * Enhanced enqueue with AI assessment and priority scoring
   */
  async function enqueue(task) {
    const taskId = task.id || randomUUID();
    const taskData = { ...task, id: taskId };
    
    // 1. AI assessment (if enabled)
    let assessment = null;
    if (config.aiAssessmentEnabled !== false) {
      assessment = aiScheduler.assessAndSchedule(taskData, priorityQueue.queue.length);
    }
    
    // 2. Task decomposition (if enabled)
    let subTasks = [];
    if (config.taskDecompositionEnabled !== false) {
      const decomposed = decomposeTask(taskData);
      if (decomposed.canDecompose && decomposed.subTasks.length > 0) {
        subTasks = decomposed.subTasks;
      }
    }
    
    // 3. Enqueue main task
    const result = priorityQueue.enqueue(taskData);
    
    // 4. Enqueue sub-tasks if decomposed
    for (const subTask of subTasks) {
      priorityQueue.enqueue({ ...subTask, parentTaskId: taskId });
    }
    
    return {
      ...result,
      assessment,
      subTasks: subTasks.map(st => st.id),
      stats: priorityQueue.getStatus()
    };
  }
  
  /**
   * Dequeue next task (respects priority order)
   */
  function dequeue() {
    return priorityQueue.dequeue();
  }
  
  /**
   * Check for timed-out tasks
   */
  function cleanupTimeouts() {
    return priorityQueue.cleanupTimeouts();
  }
  
  /**
   * Get queue status
   */
  function getStatus() {
    return {
      queue: priorityQueue.getStatus(),
      ai: aiScheduler.getStats(),
      instances: instanceMode ? loadBalancer.getLoadStatus() : null
    };
  }
  
  /**
   * Route task to best instance (if multi-instance mode)
   */
  async function routeTask(task) {
    if (!instanceMode) {
      return { routed: false, reason: 'single_instance_mode' };
    }
    
    return loadBalancer.routeTask(task);
  }
  
  /**
   * Detect conflicts between tasks
   */
  function detectConflicts(taskA, taskB) {
    return aiScheduler.detectConflicts(taskA, taskB);
  }
  
  /**
   * Get batch recommendations
   */
  function getBatchRecommendations(taskList) {
    return aiScheduler.getBatchRecommendations(taskList);
  }
  
  /**
   * Update instance configuration
   */
  function updateInstanceConfig(newConfig) {
    if (newConfig.instanceMode !== undefined) {
      instanceMode = newConfig.instanceMode;
    }
    if (newConfig.currentInstanceId !== undefined) {
      currentInstanceId = newConfig.currentInstanceId;
    }
  }
  
  return {
    enqueue,
    dequeue,
    cleanupTimeouts,
    getStatus,
    routeTask,
    detectConflicts,
    getBatchRecommendations,
    updateInstanceConfig,
    priorityQueue,
    loadBalancer,
    aiScheduler
  };
}

export { createScheduler };
