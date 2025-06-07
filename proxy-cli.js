#!/usr/bin/env node

const { ProxyManager } = require('./proxy-manager');
const { program } = require('commander');

class ProxyLogger {
  static logWithPrefix(prefix, message, type = 'info') {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const symbols = {
      info: '🔧',
      success: '✅',
      error: '❌',
      warning: '⚠️',
      progress: '⏳'
    };
    
    const symbol = symbols[type] || symbols.info;
    console.log(`[${timestamp}] ${symbol} [${prefix}] ${message}`);
  }

  static logProxyCreation(index, total, status, region = null, url = null, error = null) {
    const prefix = `Proxy ${index}/${total}`;
    
    switch (status) {
      case 'starting':
        this.logWithPrefix(prefix, `Starting creation in ${region}...`, 'progress');
        break;
      case 'success':
        this.logWithPrefix(prefix, `Created successfully: ${url} in ${region}`, 'success');
        break;
      case 'error':
        this.logWithPrefix(prefix, `Failed: ${error.message}`, 'error');
        break;
    }
  }

  static logSummary(successful, failed, total) {
    console.log('\n' + '='.repeat(60));
    console.log(`🎉 Proxy Creation Summary:`);
    console.log(`   Total Requested: ${total}`);
    console.log(`   ✅ Successful: ${successful}`);
    console.log(`   ❌ Failed: ${failed}`);
    console.log(`   📊 Success Rate: ${((successful / total) * 100).toFixed(1)}%`);
    console.log('='.repeat(60));
  }
}

async function createProxies(count, options = {}) {
  const proxyManager = new ProxyManager();
  
  try {
    ProxyLogger.logWithPrefix('INIT', 'Initializing Proxy Manager...', 'progress');
    await proxyManager.init();
    
    const currentCount = proxyManager.getProxyCount();
    ProxyLogger.logWithPrefix('INIT', `Found ${currentCount} existing proxies`, 'info');
    
    if (options.parallel !== false && count > 1) {
      await createProxiesParallel(proxyManager, count, options);
    } else {
      await createProxiesSequential(proxyManager, count, options);
    }
    
  } catch (error) {
    ProxyLogger.logWithPrefix('ERROR', `Failed to initialize: ${error.message}`, 'error');
    process.exit(1);
  }
}

async function createProxiesParallel(proxyManager, count, options) {
  ProxyLogger.logWithPrefix('CREATE', `Creating ${count} proxies with improved concurrency control...`, 'info');
  
  const startTime = Date.now();
  const regions = options.regions ? options.regions.split(',') : null;
  
  try {
    // Use the ProxyManager's built-in concurrency control
    const results = await proxyManager.createProxies(count, regions);
    const successful = results.length;
    const failed = count - successful;
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);
    
    ProxyLogger.logSummary(successful, failed, count);
    ProxyLogger.logWithPrefix('TIMING', `Total creation time: ${duration}s`, 'info');
    ProxyLogger.logWithPrefix('STATUS', `Total active proxies: ${proxyManager.getProxyCount()}`, 'info');
    
  } catch (error) {
    ProxyLogger.logWithPrefix('ERROR', `Parallel creation failed: ${error.message}`, 'error');
    process.exit(1);
  }
}

async function createProxiesSequential(proxyManager, count, options) {
  ProxyLogger.logWithPrefix('CREATE', `Creating ${count} proxies sequentially...`, 'info');
  
  const newProxies = [];
  const failed = [];
  const startTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    const proxyIndex = i + 1;
    try {
      const region = options.regions ? options.regions.split(',')[i % options.regions.split(',').length] : null;
      
      ProxyLogger.logProxyCreation(proxyIndex, count, 'starting', region || 'auto-selected');
      
      const proxy = await proxyManager.createProxy(region);
      newProxies.push(proxy);
      
      ProxyLogger.logProxyCreation(proxyIndex, count, 'success', proxy.region, proxy.url);
      
    } catch (error) {
      failed.push({ index: proxyIndex, error });
      ProxyLogger.logProxyCreation(proxyIndex, count, 'error', null, null, error);
    }
  }
  
  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(1);
  
  ProxyLogger.logSummary(newProxies.length, failed.length, count);
  ProxyLogger.logWithPrefix('TIMING', `Total creation time: ${duration}s`, 'info');
  ProxyLogger.logWithPrefix('STATUS', `Total active proxies: ${proxyManager.getProxyCount()}`, 'info');
}

async function listProxies(options = {}) {
  const proxyManager = new ProxyManager();
  
  try {
    await proxyManager.init();
    
    const proxies = proxyManager.getActiveProxies();
    
    if (proxies.length === 0) {
      console.log('📭 No active proxies found');
      return;
    }
    
    console.log(`\n📋 Active Proxies (${proxies.length}):`);
    console.log('=' .repeat(80));
    
    if (options.format === 'json') {
      console.log(JSON.stringify(proxies.map(p => ({
        url: p.url,
        region: p.region,
        serviceName: p.serviceName,
        publicIp: p.publicIp,
        createdAt: p.createdAt
      })), null, 2));
      return;
    }
    
    if (options.format === 'urls') {
      proxies.forEach(proxy => console.log(proxy.url));
      return;
    }
    
    // Group by region if requested
    if (options.groupByRegion) {
      const proxyByRegion = proxies.reduce((acc, proxy) => {
        if (!acc[proxy.region]) acc[proxy.region] = [];
        acc[proxy.region].push(proxy);
        return acc;
      }, {});
      
      Object.entries(proxyByRegion).forEach(([region, regionProxies]) => {
        console.log(`\n🌍 ${region.toUpperCase()} (${regionProxies.length} proxies):`);
        regionProxies.forEach((proxy, index) => {
          console.log(`  ${index + 1}. ${proxy.url}`);
          console.log(`     Service: ${proxy.serviceName}`);
          console.log(`     Created: ${proxy.createdAt || 'Unknown'}`);
        });
      });
      return;
    }
    
    // Default format
    proxies.forEach((proxy, index) => {
      console.log(`${index + 1}. ${proxy.url}`);
      console.log(`   Region: ${proxy.region}`);
      console.log(`   Service: ${proxy.serviceName}`);
      console.log(`   IP: ${proxy.publicIp}`);
      console.log(`   Created: ${proxy.createdAt || 'Unknown'}`);
      console.log('');
    });
    
  } catch (error) {
    ProxyLogger.logWithPrefix('ERROR', `Failed to list proxies: ${error.message}`, 'error');
    process.exit(1);
  }
}

async function teardownAllProxies(options = {}) {
  const proxyManager = new ProxyManager();
  
  try {
    await proxyManager.init();
    
    const proxyCount = proxyManager.getProxyCount();
    
    if (proxyCount === 0) {
      console.log('📭 No active proxies to teardown');
      return;
    }
    
    if (!options.force) {
      // In a real implementation, you'd want to add a confirmation prompt here
      console.log(`⚠️  About to teardown ${proxyCount} proxies. Use --force to skip confirmation.`);
      return;
    }
    
    ProxyLogger.logWithPrefix('TEARDOWN', `Tearing down ${proxyCount} proxies in parallel...`, 'progress');
    const startTime = Date.now();
    
    await proxyManager.teardownAll();
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);
    
    ProxyLogger.logWithPrefix('TEARDOWN', `All proxies torn down in ${duration}s`, 'success');
    
  } catch (error) {
    ProxyLogger.logWithPrefix('ERROR', `Failed to teardown proxies: ${error.message}`, 'error');
    process.exit(1);
  }
}

async function teardownProxy(serviceName, options = {}) {
  const proxyManager = new ProxyManager();
  
  try {
    await proxyManager.init();
    
    const proxies = proxyManager.getActiveProxies();
    const proxy = proxies.find(p => p.serviceName === serviceName || p.serviceName.includes(serviceName));
    
    if (!proxy) {
      ProxyLogger.logWithPrefix('ERROR', `Proxy with service name '${serviceName}' not found`, 'error');
      
      if (options.suggest) {
        const suggestions = proxies
          .filter(p => p.serviceName.toLowerCase().includes(serviceName.toLowerCase()))
          .slice(0, 3);
        
        if (suggestions.length > 0) {
          console.log('\n💡 Did you mean one of these?');
          suggestions.forEach(s => console.log(`   ${s.serviceName} (${s.region})`));
        }
      }
      
      process.exit(1);
    }
    
    ProxyLogger.logWithPrefix('TEARDOWN', `Tearing down ${proxy.url} in ${proxy.region}...`, 'progress');
    await proxy.teardown();
    ProxyLogger.logWithPrefix('TEARDOWN', 'Proxy successfully torn down', 'success');
    
  } catch (error) {
    ProxyLogger.logWithPrefix('ERROR', `Failed to teardown proxy: ${error.message}`, 'error');
    process.exit(1);
  }
}

async function showStatus(options = {}) {
  const proxyManager = new ProxyManager();
  await proxyManager.init();
  
  const proxies = proxyManager.getActiveProxies();
  const regions = [...new Set(proxies.map(p => p.region))];
  
  console.log(`📊 Proxy Manager Status:`);
  console.log(`   Active Proxies: ${proxies.length}`);
  console.log(`   Regions: ${regions.join(', ') || 'None'}`);
  
  if (options.detailed && proxies.length > 0) {
    console.log(`\n📈 Regional Distribution:`);
    const regionCounts = proxies.reduce((acc, proxy) => {
      acc[proxy.region] = (acc[proxy.region] || 0) + 1;
      return acc;
    }, {});
    
    Object.entries(regionCounts).forEach(([region, count]) => {
      console.log(`   ${region}: ${count} proxy${count === 1 ? '' : 'ies'}`);
    });
    
    const ages = proxies
      .filter(p => p.createdAt)
      .map(p => Date.now() - new Date(p.createdAt).getTime())
      .sort((a, b) => a - b);
    
    if (ages.length > 0) {
      const oldestHours = (ages[ages.length - 1] / (1000 * 60 * 60)).toFixed(1);
      const newestHours = (ages[0] / (1000 * 60 * 60)).toFixed(1);
      console.log(`\n⏰ Proxy Ages:`);
      console.log(`   Oldest: ${oldestHours} hours`);
      console.log(`   Newest: ${newestHours} hours`);
    }
  }
}

// CLI setup
program
  .name('proxy-cli')
  .description('CLI for managing AWS Fargate SOCKS5 proxies')
  .version('1.0.0');

program
  .command('create <count>')
  .description('Create N new proxies')
  .option('-s, --sequential', 'Create proxies sequentially instead of in parallel')
  .option('-r, --regions <regions>', 'Comma-separated list of regions to use')
  .option('-v, --verbose', 'Show detailed error information')
  .action(async (count, options) => {
    const num = parseInt(count);
    if (isNaN(num) || num <= 0) {
      ProxyLogger.logWithPrefix('ERROR', 'Count must be a positive number', 'error');
      process.exit(1);
    }
    
    const createOptions = {
      parallel: !options.sequential,
      regions: options.regions,
      verbose: options.verbose
    };
    
    await createProxies(num, createOptions);
  });

program
  .command('list')
  .alias('ls')
  .description('List all active proxies')
  .option('-f, --format <format>', 'Output format: default, json, urls', 'default')
  .option('-g, --group-by-region', 'Group proxies by region')
  .action(async (options) => {
    await listProxies(options);
  });

program
  .command('teardown-all')
  .alias('destroy-all')
  .description('Teardown all active proxies')
  .option('--force', 'Skip confirmation prompt')
  .action(async (options) => {
    await teardownAllProxies(options);
  });

program
  .command('teardown <service-name>')
  .alias('destroy')
  .description('Teardown a specific proxy by service name (supports partial matching)')
  .option('--suggest', 'Show suggestions if exact match not found')
  .action(async (serviceName, options) => {
    await teardownProxy(serviceName, options);
  });

program
  .command('logs [service-name]')
  .description('Show logs for a specific proxy or all proxies')
  .option('-n, --lines <number>', 'Number of log lines to show', '50')
  .action(async (serviceName, options) => {
    const lines = parseInt(options.lines) || 50;
    
    const proxyManager = new ProxyManager();
    await proxyManager.init();
    
    if (serviceName) {
      const proxies = proxyManager.getActiveProxies();
      const proxy = proxies.find(p => p.serviceName.includes(serviceName));
      
      if (!proxy) {
        ProxyLogger.logWithPrefix('ERROR', `Proxy with service name '${serviceName}' not found`, 'error');
        process.exit(1);
      }
      
      await proxyManager.printRecentLogs(proxy.region, lines);
    } else {
      await proxyManager.printRecentLogs(null, lines);
    }
  });

program
  .command('status')
  .description('Show proxy manager status')
  .option('-d, --detailed', 'Show detailed status information')
  .action(async (options) => {
    await showStatus(options);
  });

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  ProxyLogger.logWithPrefix('FATAL', `Uncaught exception: ${error.message}`, 'error');
  console.error(error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  ProxyLogger.logWithPrefix('FATAL', `Unhandled rejection: ${reason}`, 'error');
  process.exit(1);
});

// Parse command line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
