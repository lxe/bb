const puppeteer = require('puppeteer');
const useProxy = require('@lem0-packages/puppeteer-page-proxy');
const { ProxyManager } = require('./proxy-manager');

async function testIPLeak() {
  console.log('🔍 Testing for IP leaks...');
  
  const proxyManager = new ProxyManager();
  await proxyManager.init();
  const proxies = proxyManager.getActiveProxies();
  
  if (proxies.length === 0) {
    console.error('❌ No proxies available for testing');
    return;
  }
  
  const proxy = proxies[0];
  console.log(`🔧 Testing with proxy: ${proxy.region} (${proxy.publicIp})`);
  
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--disable-web-security',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // WebRTC leak prevention
      '--disable-webrtc-hw-decoding',
      '--disable-webrtc-hw-encoding', 
      '--disable-webrtc-multiple-routes',
      '--disable-webrtc-hw-vp8-encoding',
      '--enforce-webrtc-ip-permission-check',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      // DNS leak prevention
      '--disable-dns-prefetching',
      '--disable-dns-over-https',
      '--disable-background-networking',
      '--disable-preconnect',
    ]
  });
  
  const page = await browser.newPage();
  
  try {
    // Set proxy
    await useProxy(page, proxy.url);
    
    // Disable WebRTC APIs
    await page.evaluateOnNewDocument(() => {
      if (typeof navigator !== 'undefined') {
        navigator.mediaDevices = navigator.mediaDevices || {};
        navigator.mediaDevices.getUserMedia = undefined;
        navigator.webkitGetUserMedia = undefined;
        navigator.mozGetUserMedia = undefined;
        navigator.getUserMedia = undefined;
      }
      
      if (typeof window !== 'undefined') {
        window.RTCPeerConnection = undefined;
        window.webkitRTCPeerConnection = undefined;
        window.mozRTCPeerConnection = undefined;
        window.MediaStreamTrack = undefined;
        window.RTCDataChannel = undefined;
      }
    });
    
    console.log('📡 Testing basic IP detection...');
    
    // Test 1: Basic IP check
    await page.goto('https://httpbin.org/ip', { waitUntil: 'networkidle0' });
    const ipResult = await page.evaluate(() => {
      try {
        return JSON.parse(document.body.innerText);
      } catch (e) {
        return { origin: document.body.innerText.trim() };
      }
    });
    
    console.log(`🌐 Detected IP: ${ipResult.origin}`);
    console.log(`🎯 Expected proxy IP: ${proxy.publicIp}`);
    
    if (ipResult.origin === proxy.publicIp) {
      console.log('✅ Basic IP test PASSED - Using proxy IP');
    } else {
      console.log('❌ Basic IP test FAILED - Not using proxy IP');
    }
    
    console.log('\n📡 Testing WebRTC leak detection...');
    
    // Test 2: WebRTC leak test
    await page.goto('https://browserleaks.com/webrtc', { waitUntil: 'networkidle0' });
    await page.waitForTimeout(5000); // Wait for WebRTC detection
    
    const webrtcResult = await page.evaluate(() => {
      const elements = document.querySelectorAll('td, div, span');
      const ipPattern = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g;
      const foundIPs = new Set();
      
      elements.forEach(el => {
        const text = el.textContent || '';
        const matches = text.match(ipPattern);
        if (matches) {
          matches.forEach(ip => {
            // Filter out common non-real IPs
            if (!ip.startsWith('127.') && !ip.startsWith('0.') && ip !== '0.0.0.0') {
              foundIPs.add(ip);
            }
          });
        }
      });
      
      return Array.from(foundIPs);
    });
    
    console.log(`🔍 WebRTC detected IPs: ${webrtcResult.join(', ') || 'None'}`);
    
    if (webrtcResult.length === 0) {
      console.log('✅ WebRTC leak test PASSED - No IPs detected');
    } else if (webrtcResult.length === 1 && webrtcResult[0] === proxy.publicIp) {
      console.log('✅ WebRTC leak test PASSED - Only proxy IP detected');
    } else {
      console.log('❌ WebRTC leak test FAILED - Unexpected IPs detected');
      console.log('⚠️  This could indicate an IP leak!');
    }
    
    console.log('\n📡 Testing DNS leak detection...');
    
    // Test 3: DNS leak test (simplified)
    await page.goto('https://dnsleaktest.com/', { waitUntil: 'networkidle0' });
    await page.waitForTimeout(3000);
    
    const dnsResult = await page.evaluate(() => {
      const elements = document.querySelectorAll('*');
      const ipPattern = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g;
      const foundIPs = new Set();
      
      elements.forEach(el => {
        const text = el.textContent || '';
        const matches = text.match(ipPattern);
        if (matches) {
          matches.forEach(ip => {
            if (!ip.startsWith('127.') && !ip.startsWith('0.') && ip !== '0.0.0.0') {
              foundIPs.add(ip);
            }
          });
        }
      });
      
      return Array.from(foundIPs);
    });
    
    console.log(`🔍 DNS test detected IPs: ${dnsResult.join(', ') || 'None'}`);
    
    // Summary
    console.log('\n📊 SUMMARY:');
    console.log(`Expected proxy IP: ${proxy.publicIp}`);
    console.log(`Basic IP test: ${ipResult.origin === proxy.publicIp ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`WebRTC leak test: ${webrtcResult.length === 0 || (webrtcResult.length === 1 && webrtcResult[0] === proxy.publicIp) ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`DNS leak test: ${dnsResult.length <= 1 ? '✅ PASS' : '⚠️  CHECK'}`);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await browser.close();
  }
}

// Run the test
testIPLeak().catch(console.error); 