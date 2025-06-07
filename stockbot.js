const puppeteer = require('puppeteer');
const useProxy = require('@lem0-packages/puppeteer-page-proxy');
const { ProxyManager } = require('./proxy-manager');
const WebServer = require('./web-server');
const fs = require('fs').promises;

// ===== ASYNC QUEUE IMPLEMENTATION =====

class AsyncQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  async add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    this.running++;
    const { task, resolve, reject } = this.queue.shift();

    try {
      const result = await task();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      this.process(); // Process next task
    }
  }
}

// ===== PRIORITY QUEUE WITH LINE-CUTTING =====

class PriorityQueue {
  constructor() {
    this.urls = []; // Main URL rotation array
    this.currentIndex = 0;
    this.priorityMap = new Map(); // url -> { priority: 1-3, addedAt: timestamp }
    this.lastPriorityCheck = new Map(); // url -> last check timestamp
    this.maxLineCuts = 5; // Maximum positions a priority URL can cut ahead
    this.priorityCheckInterval = 30000; // 30 seconds minimum between priority checks
  }

  initialize(urls) {
    this.urls = [...urls];
    this.currentIndex = 0;
    this.priorityMap.clear();
    this.lastPriorityCheck.clear();
  }

  // Set priority level for a URL (1 = highest, 3 = lowest, 0 = remove priority)
  setPriority(url, priority, reason = '') {
    if (priority === 0) {
      if (this.priorityMap.has(url)) {
        this.priorityMap.delete(url);
        this.lastPriorityCheck.delete(url);
        console.log(`❄️ Removed priority: ${url} (${reason})`);
      }
      return;
    }

    const existingPriority = this.priorityMap.get(url);
    if (existingPriority && existingPriority.priority === priority) {
      // Priority level unchanged, just update timestamp
      existingPriority.addedAt = Date.now();
      return;
    }

    this.priorityMap.set(url, {
      priority: priority,
      addedAt: Date.now()
    });

    const priorityNames = { 1: 'HIGH', 2: 'MEDIUM', 3: 'LOW' };
    console.log(`🔥 Set priority ${priorityNames[priority]}: ${url} (${reason})`);
  }

  // Get next URL using line-cutting logic
  getNextUrl() {
    if (this.urls.length === 0) return null;

    // Check if we have any priority URLs that are due for checking
    const priorityUrl = this.getNextPriorityUrl();
    if (priorityUrl) {
      return priorityUrl;
    }

    // No priority URLs ready, return next regular URL
    const url = this.urls[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.urls.length;
    return url;
  }

  getNextPriorityUrl() {
    const now = Date.now();
    
    // Find all priority URLs that are ready for checking
    const readyPriorityUrls = [];
    
    for (const [url, info] of this.priorityMap.entries()) {
      const lastCheck = this.lastPriorityCheck.get(url) || 0;
      const timeSinceLastCheck = now - lastCheck;
      
      // Check if enough time has passed since last priority check
      if (timeSinceLastCheck >= this.priorityCheckInterval) {
        readyPriorityUrls.push({ url, ...info });
      }
    }

    if (readyPriorityUrls.length === 0) {
      return null;
    }

    // Sort by priority level (1 = highest priority first)
    readyPriorityUrls.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority; // Lower number = higher priority
      }
      return a.addedAt - b.addedAt; // Older first if same priority
    });

    // Get the highest priority URL that can cut in line
    for (const priorityUrl of readyPriorityUrls) {
      if (this.canCutInLine(priorityUrl.url, priorityUrl.priority)) {
        this.lastPriorityCheck.set(priorityUrl.url, now);
        console.log(`⚡ Priority check (${this.getPriorityName(priorityUrl.priority)}): ${priorityUrl.url}`);
        return priorityUrl.url;
      }
    }

    return null;
  }

  canCutInLine(url, priority) {
    // Find the position of this URL in the regular rotation
    const urlIndex = this.urls.indexOf(url);
    if (urlIndex === -1) return false;

    // Calculate how far ahead this URL would be cutting
    let cutDistance = 0;
    if (urlIndex >= this.currentIndex) {
      cutDistance = urlIndex - this.currentIndex;
    } else {
      cutDistance = (this.urls.length - this.currentIndex) + urlIndex;
    }

    // Higher priority (lower number) can cut further ahead
    const maxCutsForPriority = {
      1: this.maxLineCuts * 2,     // HIGH priority can cut up to 10 positions
      2: this.maxLineCuts,         // MEDIUM priority can cut up to 5 positions  
      3: Math.floor(this.maxLineCuts / 2) // LOW priority can cut up to 2 positions
    };

    return cutDistance <= (maxCutsForPriority[priority] || 0);
  }

  getPriorityName(priority) {
    const names = { 1: 'HIGH', 2: 'MEDIUM', 3: 'LOW' };
    return names[priority] || 'UNKNOWN';
  }

  // Get status information
  getStatus() {
    const priorityStats = {};
    for (const [url, info] of this.priorityMap.entries()) {
      const priorityName = this.getPriorityName(info.priority);
      priorityStats[priorityName] = (priorityStats[priorityName] || 0) + 1;
    }

    return {
      totalUrls: this.urls.length,
      currentPosition: this.currentIndex + 1,
      cycle: Math.floor(this.currentIndex / this.urls.length) + 1,
      priorityStats
    };
  }
}

// ===== PERSISTENT PAGE WORKER =====

class PageWorker {
  constructor(id, proxy, stockBot) {
    this.id = id;
    this.proxy = proxy;
    this.stockBot = stockBot;
    this.page = null;
    this.isRunning = false;
  }

  async init() {
    console.log(`🔧 [Worker ${this.id}] Initializing with proxy: ${this.proxy.region}`);
    this.page = await this.stockBot.browser.newPage();
    
    // Configure proxy and privacy settings once
    await useProxy(this.page, this.proxy.url);
    await this.stockBot.setupPagePrivacy(this.page);
    
    console.log(`✅ [Worker ${this.id}] Ready with proxy: ${this.proxy.region}`);
  }

  async start() {
    this.isRunning = true;
    
    while (this.isRunning) {
      const url = this.stockBot.getNextUrl();
      if (!url) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      console.log(`🔄 [Worker ${this.id} - ${this.proxy.region}] Processing: ${url}`);
      
      // Send loading state to web clients
      if (this.stockBot.webServer) {
        this.stockBot.webServer.broadcastLoading(url, this.proxy.region);
      }

      try {
        // Extract data from API response
        const extractedData = await this.stockBot.extractStockDataWithPage(this.page, url);

        if (extractedData) {
          await this.stockBot.processStockData(extractedData, url, this.proxy.region);
        } else {
          console.log(`📭 [Worker ${this.id} - ${this.proxy.region}] No API data found for: ${url}`);
          await this.stockBot.takeDebugScreenshot(this.page, url, this.proxy.region);
        }
      } catch (error) {
        console.error(`❌ [Worker ${this.id} - ${this.proxy.region}] Error processing ${url}:`, error.message);
      }

      // Wait 500ms before processing next URL
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  async stop() {
    this.isRunning = false;
    if (this.page) {
      await this.page.close();
      console.log(`🛑 [Worker ${this.id}] Stopped`);
    }
  }
}

// ===== MAIN STOCKBOT CLASS =====

class StockBot {
  constructor() {
    this.browser = null;
    this.proxyManager = new ProxyManager();
    this.proxies = [];
    this.stockData = new Map(); // spuExtId -> Map(url -> stockEntry)
    this.products = []; // Array of {baseUrl, count, spuExtId, urls}
    this.priorityQueue = new PriorityQueue(); // New priority queue system
    this.isRunning = false;
    this.webServer = null;
    this.workers = []; // Persistent page workers
  }

  // ===== INITIALIZATION =====

  async init() {
    console.log('🚀 Initializing StockBot...');
    await this.setupProxies();
    await this.launchBrowser();

    this.webServer = new WebServer(this);
    this.webServer.start();
  }

  async setupProxies() {
    await this.proxyManager.init();
    this.proxies = this.proxyManager.getActiveProxies();

    if (this.proxies.length === 0) {
      throw new Error('No proxies available. Use proxy-cli to create proxies first.');
    }

    console.log(`✅ ${this.proxies.length} proxies loaded`);
  }

  async launchBrowser() {
    console.log('🌐 Launching browser...');
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--disable-web-security',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--disable-webrtc-hw-decoding',
        '--disable-webrtc-hw-encoding',
        '--disable-dns-prefetching',
        '--disable-background-networking',
        '--disable-dev-shm-usage',
      ],
    });
    console.log('✅ Browser launched');
  }

  async initializeWorkers(urlCount) {
    // Calculate optimal number of workers: min(urlCount, proxies.length)
    const workerCount = Math.min(urlCount, this.proxies.length);
    console.log(`🏭 Initializing ${workerCount} persistent workers (${urlCount} URLs, ${this.proxies.length} proxies)`);

    // Create workers with dedicated proxies
    for (let i = 0; i < workerCount; i++) {
      const proxy = this.proxies[i];
      const worker = new PageWorker(i + 1, proxy, this);
      await worker.init();
      this.workers.push(worker);
    }

    console.log(`✅ ${workerCount} workers initialized`);
  }

  // ===== URL GENERATION =====

  generateUrlsForProduct(baseUrl, count) {
    console.log(`📋 Generating ${count} URLs from: ${baseUrl}`);

    // Pattern: {prefix}-1000{5digits}{suffix}
    const urlPattern = /^(.+-1000)(\d{5})(\d+)$/;
    const match = baseUrl.match(urlPattern);

    if (!match) {
      throw new Error('Invalid URL pattern. Expected: .../PREFIX-1000XXXXX... where XXXXX are 5 digits to increment');
    }

    const [, prefix, baseNumberStr, suffix] = match;
    const baseNumber = parseInt(baseNumberStr);

    // Extract spuExtId from baseUrl (the number before -1000)
    const spuExtIdMatch = baseUrl.match(/(\d+)-1000\d+/);
    const spuExtId = spuExtIdMatch ? parseInt(spuExtIdMatch[1]) : null;

    if (!spuExtId) {
      throw new Error('Could not extract spuExtId from URL');
    }

    const urls = [];
    for (let i = 0; i < count; i++) {
      const newNumber = (baseNumber + i).toString().padStart(5, '0');
      urls.push(`${prefix}${newNumber}${suffix}`);
    }

    console.log(`✅ Generated URLs for product ${spuExtId}: ${baseNumberStr} to ${(baseNumber + count - 1).toString().padStart(5, '0')}`);
    return { spuExtId, urls };
  }

  setupProducts(productSpecs) {
    console.log(`🏭 Setting up ${productSpecs.length} products...`);
    
    // Generate URLs for each product
    for (const { baseUrl, count } of productSpecs) {
      const { spuExtId, urls } = this.generateUrlsForProduct(baseUrl, count);
      this.products.push({
        baseUrl,
        count,
        spuExtId,
        urls
      });
    }

    // Interleave URLs from all products for fair distribution
    this.interleaveUrls();
    
    console.log(`✅ Setup complete: ${this.products.length} products, ${this.priorityQueue.urls.length} total URLs`);
  }

  interleaveUrls() {
    const urlQueues = this.products.map(product => [...product.urls]);
    const interleavedUrls = [];

    // Keep going until all queues are empty
    while (urlQueues.some(queue => queue.length > 0)) {
      for (let i = 0; i < urlQueues.length; i++) {
        if (urlQueues[i].length > 0) {
          interleavedUrls.push(urlQueues[i].shift());
        }
      }
    }

    this.priorityQueue.initialize(interleavedUrls);
    console.log(`🔀 Interleaved ${interleavedUrls.length} URLs across ${this.products.length} products`);
  }

  getNextUrl() {
    return this.priorityQueue.getNextUrl();
  }

  // ===== PRIORITY MANAGEMENT =====

  updateUrlPriority(url, extractedData) {
    if (!extractedData?.data?.box_list) {
      this.priorityQueue.setPriority(url, 0, 'no data');
      return;
    }

    const boxList = extractedData.data.box_list;
    let hasReserved = false;
    let hasInStock = false;

    boxList.forEach((box) => {
      if (box.position >= 1 && box.position <= 6) {
        // Check for reserved (state 2)
        if (box.state === 2) {
          hasReserved = true;
        }
        // Check for in stock (state 0 with box_no)
        if (box.state === 0 && box.box_no && box.box_no.trim() !== '') {
          hasInStock = true;
        }
      }
    });

    if (hasReserved && hasInStock) {
      this.priorityQueue.setPriority(url, 1, 'reserved + in-stock'); // HIGH priority
    } else if (hasReserved) {
      this.priorityQueue.setPriority(url, 2, 'reserved'); // MEDIUM priority
    } else if (hasInStock) {
      this.priorityQueue.setPriority(url, 3, 'in-stock'); // LOW priority
    } else {
      this.priorityQueue.setPriority(url, 0, 'no priority conditions'); // Remove priority
    }
  }

  // ===== DATA PERSISTENCE =====

  async loadExistingTsvData(spuExtId) {
    const filename = `${spuExtId}.tsv`;

    try {
      const content = await fs.readFile(filename, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim());

      if (lines.length <= 1) {
        console.log(`📄 ${filename} is empty`);
        this.stockData.set(spuExtId, new Map());
        return;
      }

      const headers = lines[0].split('\t');
      const urlMap = new Map();

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split('\t');
        const entry = {};
        headers.forEach((header, index) => {
          entry[header] = values[index] || '';
        });

        if (entry.url) {
          urlMap.set(entry.url, entry);
        }
      }

      this.stockData.set(spuExtId, urlMap);
      console.log(`✅ Loaded ${urlMap.size} entries from ${filename}`);
    } catch (error) {
      console.log(`📄 ${filename} doesn't exist, creating new`);
      this.stockData.set(spuExtId, new Map());
    }
  }

  async updateTsvFile(spuExtId) {
    const filename = `${spuExtId}.tsv`;
    const urlMap = this.stockData.get(spuExtId);

    if (!urlMap || urlMap.size === 0) return;

    const headers = ['url', 'state0', 'state1', 'state2', 'state3', 'state4', 'state5', 'stock', 'lastChecked'];
    const headerLine = headers.join('\t');

    const dataLines = Array.from(urlMap.values()).map((entry) =>
      headers.map((header) => entry[header] || '').join('\t')
    );

    const tsvContent = [headerLine, ...dataLines].join('\n');
    await fs.writeFile(filename, tsvContent);
  }

  // ===== CORE PROCESSING =====

  async setupPagePrivacy(page) {
    // Block WebRTC and set fake headers to prevent IP leaks
    await page.evaluateOnNewDocument(() => {
      if (typeof navigator !== 'undefined') {
        navigator.mediaDevices = undefined;
        navigator.webkitGetUserMedia = undefined;
      }

      if (typeof window !== 'undefined') {
        window.RTCPeerConnection = undefined;
        window.webkitRTCPeerConnection = undefined;
      }
    });

    const fakeIP = this.generateRandomXfinityIP();
    await page.setExtraHTTPHeaders({
      'X-Forwarded-For': fakeIP,
      'X-Real-IP': fakeIP,
      'X-Client-IP': fakeIP,
    });
  }

  generateRandomXfinityIP() {
    // Generate random IP from Xfinity ranges
    const ranges = [
      () => `50.218.46.${Math.floor(Math.random() * 254) + 1}`,
      () => {
        const second = Math.floor(Math.random() * 16) + 192;
        const third = Math.floor(Math.random() * 256);
        const fourth = Math.floor(Math.random() * 254) + 1;
        return `71.${second}.${third}.${fourth}`;
      },
    ];

    return ranges[Math.floor(Math.random() * ranges.length)]();
  }

  async extractStockData(page, url) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 30000);

      page.on('response', async (response) => {
        if (response.url().includes('prod-na-api.popmart.com/shop/v1/box/box_set/refreshBox')) {
          try {
            const jsonData = await response.json();
            clearTimeout(timeout);
            resolve(jsonData);
          } catch (error) {
            console.warn(`⚠️ Failed to parse API response:`, error.message);
            clearTimeout(timeout);
            resolve(null);
          }
        }
      });

      page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {
        clearTimeout(timeout);
        resolve(null);
      });
    });
  }

  async extractStockDataWithPage(page, url) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 30000);

      const responseHandler = async (response) => {
        if (response.url().includes('prod-na-api.popmart.com/shop/v1/box/box_set/refreshBox')) {
          try {
            const jsonData = await response.json();
            clearTimeout(timeout);
            page.off('response', responseHandler);
            resolve(jsonData);
          } catch (error) {
            console.warn(`⚠️ Failed to parse API response:`, error.message);
            clearTimeout(timeout);
            page.off('response', responseHandler);
            resolve(null);
          }
        }
      };

      page.on('response', responseHandler);

      page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {
        clearTimeout(timeout);
        page.off('response', responseHandler);
        resolve(null);
      });
    });
  }

  async processStockData(extractedData, url, proxyRegion) {
    if (!extractedData?.data?.box_list) return;

    const spuExtId = extractedData.data.spu_ext_id;
    const boxList = extractedData.data.box_list;

    // Update priority based on current data
    this.updateUrlPriority(url, extractedData);

    // Extract states (positions 1-6 -> indices 0-5)
    const states = new Array(6).fill('');
    let hasStock = false;

    boxList.forEach((box) => {
      if (box.position >= 1 && box.position <= 6) {
        states[box.position - 1] = box.state.toString();
        if (box.box_no && box.box_no.trim() !== '') {
          hasStock = true;
        }
      }
    });

    const stockEntry = {
      url,
      state0: states[0] || '',
      state1: states[1] || '',
      state2: states[2] || '',
      state3: states[3] || '',
      state4: states[4] || '',
      state5: states[5] || '',
      stock: hasStock ? 'true' : 'false',
      lastChecked: new Date().toISOString(),
    };

    // Load existing data if needed
    if (!this.stockData.has(spuExtId)) {
      await this.loadExistingTsvData(spuExtId);
    }

    // Check for changes and update
    const urlMap = this.stockData.get(spuExtId);
    const existingEntry = urlMap.get(url);
    const dataChanged = this.hasDataChanged(existingEntry, stockEntry);

    if (dataChanged) {
      urlMap.set(url, stockEntry);
      await this.updateTsvFile(spuExtId);
      console.log(`💾 [${proxyRegion}] Updated: ${url} [${states.join(' ')}] stock:${hasStock}`);
    } else {
      console.log(`✅ [${proxyRegion}] No change: ${url} [${states.join(' ')}] stock:${hasStock}`);
    }

    // Broadcast to web clients
    if (this.webServer) {
      this.webServer.broadcastUpdate(spuExtId, url, stockEntry);
    }
  }

  hasDataChanged(existingEntry, newEntry) {
    if (!existingEntry) return true;

    const oldStates = [
      existingEntry.state0,
      existingEntry.state1,
      existingEntry.state2,
      existingEntry.state3,
      existingEntry.state4,
      existingEntry.state5,
    ].join(' ');
    const newStates = [
      newEntry.state0,
      newEntry.state1,
      newEntry.state2,
      newEntry.state3,
      newEntry.state4,
      newEntry.state5,
    ].join(' ');

    return oldStates !== newStates || existingEntry.stock !== newEntry.stock;
  }

  async takeDebugScreenshot(page, url, proxyRegion) {
    try {
      const urlId = this.extractIdFromUrl(url);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = `debug-${urlId}-${timestamp}.png`;

      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`📸 [${proxyRegion}] Screenshot: ${screenshotPath}`);
    } catch (error) {
      console.error(`❌ Screenshot failed:`, error.message);
    }
  }

  extractIdFromUrl(url) {
    const match = url.match(/(\d+-\d+)$/);
    return match ? match[1] : 'unknown';
  }

  // ===== MAIN MONITORING LOOP =====

  async startContinuousMonitoring() {
    console.log('🔄 Starting continuous monitoring...');
    this.isRunning = true;

    // Status monitoring
    const statusInterval = setInterval(() => {
      if (this.isRunning) {
        const activeWorkers = this.workers.filter(w => w.isRunning).length;
        const queueStatus = this.priorityQueue.getStatus();
        
        let statusMessage = `📊 Workers: ${activeWorkers}/${this.workers.length} active | Round-robin: cycle ${queueStatus.cycle}, position ${queueStatus.currentPosition}/${queueStatus.totalUrls}`;
        
        if (Object.keys(queueStatus.priorityStats).length > 0) {
          const priorityInfo = Object.entries(queueStatus.priorityStats)
            .map(([level, count]) => `${level}: ${count}`)
            .join(', ');
          statusMessage += ` | Priority: ${priorityInfo}`;
        }
        
        console.log(statusMessage);
      }
    }, 3000);

    // Start all workers
    const workerPromises = this.workers.map(worker => worker.start());

    // Wait for all workers to complete (they run indefinitely until stopped)
    await Promise.all(workerPromises);

    clearInterval(statusInterval);
  }

  // ===== SHUTDOWN =====

  async stop() {
    console.log('\n🛑 Stopping monitoring...');
    this.isRunning = false;

    // Stop all workers
    await Promise.all(this.workers.map(worker => worker.stop()));

    if (this.webServer) {
      this.webServer.stop();
    }
  }

  async cleanup() {
    console.log('🧹 Cleaning up...');

    if (this.browser) {
      await this.browser.close();
    }

    console.log('✅ Cleanup complete');
  }
}

// ===== MAIN EXECUTION =====

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args.length % 2 !== 0) {
    console.error('❌ Usage: node stockbot.js <base_url1> <count1> [<base_url2> <count2> ...]');
    console.error('Example: node stockbot.js https://www.popmart.com/us/pop-now/set/195-10002154800585 50');
    console.error('Example: node stockbot.js https://www.popmart.com/us/pop-now/set/50-10009450600350 50 https://www.popmart.com/us/pop-now/set/195-10002025000585 50');
    process.exit(1);
  }

  // Parse URL/count pairs
  const productSpecs = [];
  for (let i = 0; i < args.length; i += 2) {
    const baseUrl = args[i];
    const count = parseInt(args[i + 1]);

    if (isNaN(count) || count <= 0) {
      console.error(`❌ Count must be a positive number: ${args[i + 1]}`);
      process.exit(1);
    }

    productSpecs.push({ baseUrl, count });
  }

  console.log(`🎯 Processing ${productSpecs.length} product(s):`);
  productSpecs.forEach((spec, index) => {
    console.log(`  ${index + 1}. ${spec.baseUrl} (${spec.count} URLs)`);
  });

  const stockBot = new StockBot();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await stockBot.stop();
    await stockBot.cleanup();
    process.exit(0);
  });

  try {
    await stockBot.init();

    // Setup products and generate interleaved URLs
    stockBot.setupProducts(productSpecs);

    // Load existing data for all products
    const uniqueSpuExtIds = new Set();
    stockBot.products.forEach(product => {
      uniqueSpuExtIds.add(product.spuExtId);
    });

    for (const spuExtId of uniqueSpuExtIds) {
      await stockBot.loadExistingTsvData(spuExtId);
    }

    // Calculate total URL count for worker initialization
    const totalUrlCount = productSpecs.reduce((sum, spec) => sum + spec.count, 0);

    // Initialize workers based on total URL count and proxy count
    await stockBot.initializeWorkers(totalUrlCount);

    await stockBot.startContinuousMonitoring();
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  } finally {
    await stockBot.cleanup();
  }
}

if (require.main === module) {
  main();
}

module.exports = StockBot;
