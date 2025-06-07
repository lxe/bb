# 🛡️ Proxy Security and IP Leak Prevention

This document outlines the comprehensive security measures implemented in the StockBot system to prevent IP address leakage when using AWS Fargate SOCKS5 proxies.

## 🔒 Multi-Layer Security Architecture

The StockBot implements defense-in-depth security with multiple overlapping protection mechanisms:

### 1. **Browser-Level Security** 
### 2. **Network-Level Security**
### 3. **Application-Level Security**
### 4. **AWS Infrastructure Security**

---

## 🌐 Browser-Level IP Leak Prevention

### WebRTC Complete Lockdown

WebRTC can bypass proxy settings and reveal your real IP address through ICE candidates. Our implementation uses aggressive blocking:

#### Browser Launch Arguments
```javascript
const browserArgs = [
  '--disable-webrtc-hw-decoding',
  '--disable-webrtc-hw-encoding', 
  '--disable-dns-prefetching',
  '--disable-background-networking',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--ignore-certificate-errors'
];
```

#### JavaScript API Neutralization
```javascript
await page.evaluateOnNewDocument(() => {
  // Completely disable WebRTC APIs
  if (typeof navigator !== 'undefined') {
    navigator.mediaDevices = undefined;
    navigator.webkitGetUserMedia = undefined;
  }

  // Block WebRTC peer connections
  if (typeof window !== 'undefined') {
    window.RTCPeerConnection = undefined;
    window.webkitRTCPeerConnection = undefined;
  }
});
```

### HTTP Header Spoofing

The system injects fake headers to mask the real IP:

```javascript
const fakeIP = generateRandomXfinityIP();
await page.setExtraHTTPHeaders({
  'X-Forwarded-For': fakeIP,
  'X-Real-IP': fakeIP,
  'X-Client-IP': fakeIP,
});
```

#### Xfinity IP Generation
Uses realistic Xfinity IP ranges:
- `50.218.46.x` range
- `71.192-207.x.x` ranges

---

## 🚇 Network-Level Security

### SOCKS5 Proxy Implementation

Each worker uses dedicated SOCKS5 proxies via `@lem0-packages/puppeteer-page-proxy`:

```javascript
// Dedicated proxy per worker
await useProxy(this.page, this.proxy.url);
```

### Persistent Page Architecture

- **No proxy switching** during session to prevent leaks
- **Dedicated proxy per worker** ensures consistent routing
- **500ms delays** prevent overwhelming proxy connections

### Connection Isolation

```javascript
// Each worker maintains isolated browser page
class PageWorker {
  constructor(id, proxy, stockBot) {
    this.proxy = proxy;  // Dedicated proxy assignment
    this.page = null;    // Isolated browser page
  }
}
```

---

## 🏗️ AWS Infrastructure Security

### Custom Security Group

Automatically creates `stockbot-socks5-proxy-sg`:

```javascript
// Minimal security group - only SOCKS5 port
{
  GroupName: 'stockbot-socks5-proxy-sg',
  Description: 'Security group for StockBot SOCKS5 proxies',
  IpPermissions: [{
    IpProtocol: 'tcp',
    FromPort: 1080,
    ToPort: 1080,
    IpRanges: [{ CidrIp: '0.0.0.0/0' }]
  }]
}
```

### Resource Isolation

- **Fargate tasks**: Isolated containers per proxy
- **Public IP assignment**: Each proxy gets unique IP
- **Resource tagging**: All resources tagged for tracking
- **Auto-cleanup**: Failed resources automatically removed

### Regional Distribution

Proxies are distributed across AWS regions:
- us-west-1 (N. California)
- us-west-2 (Oregon)  
- us-east-1 (N. Virginia)
- us-east-2 (Ohio)
- ca-central-1 (Canada)
- eu-west-1 (Ireland)

---

## 🔍 Application-Level Security

### Proxy State Management

```javascript
class ProxyManager {
  // Validates proxy health before use
  async validateProxies() {
    const validProxies = [];
    for (const proxy of this.proxies) {
      if (await this.isProxyHealthy(proxy)) {
        validProxies.push(proxy);
      }
    }
  }
}
```

### Connection Monitoring

Real-time proxy health monitoring:
- **Health checks** before assignment
- **Automatic failover** to working proxies
- **Dead proxy removal** from rotation

### Error Isolation

```javascript
// Graceful error handling prevents IP exposure
try {
  const result = await this.extractStockDataWithPage(page, url);
} catch (error) {
  console.error(`Worker ${id} error:`, error.message);
  // Continue with next URL - no proxy switching
}
```

---

## 🧪 Security Testing & Validation

### Automated Testing

Built-in IP leak detection:

```bash
# Test for IP leaks
node test-ip-leak.js

# Check proxy functionality
node proxy-cli.js status
```

### Manual Testing Commands

```bash
# Test current public IP through proxy
curl -x socks5://proxy:1080 https://httpbin.org/ip

# Check for WebRTC leaks
node -e "console.log('WebRTC APIs:', typeof RTCPeerConnection)"

# Monitor network connections
netstat -tuln | grep ESTABLISHED
```

### Web-Based Testing

Access these URLs through the dashboard to verify IP masking:
- `https://whatismyipaddress.com/`
- `https://browserleaks.com/webrtc`
- `https://dnsleaktest.com/`

---

## 📊 Security Monitoring

### Real-Time Monitoring

The web dashboard provides security indicators:

```javascript
// Connection status monitoring
const connectionStatus = {
  proxiesActive: this.proxies.filter(p => p.isHealthy).length,
  workersRunning: this.workers.filter(w => w.isRunning).length,
  lastSecurityCheck: Date.now()
};
```

### Logging & Alerts

Security events are logged with clear indicators:

```
🛡️ [Security] Proxy assigned: us-west-1 -> Worker 3
🚨 [Alert] Direct IP access blocked: 192.168.1.100
✅ [Security] WebRTC disabled for new page
🔄 [Security] Proxy rotation: Worker 5 -> us-east-2
```

---

## ⚠️ Security Best Practices

### 🟢 **DO:**
- ✅ Regularly rotate proxies (weekly)
- ✅ Monitor proxy health status
- ✅ Use test-ip-leak.js for verification
- ✅ Keep proxy count < URL count for optimal security
- ✅ Monitor CloudWatch logs for anomalies
- ✅ Use dedicated AWS account for proxy resources

### 🔴 **DON'T:**
- ❌ Reuse proxies across different applications
- ❌ Leave failed proxies running
- ❌ Share proxy credentials
- ❌ Disable security group restrictions
- ❌ Run without testing IP leak prevention
- ❌ Mix proxy and direct connections

---

## 🚨 Security Incident Response

### Suspected IP Leak

1. **Immediate Actions:**
   ```bash
   # Stop all workers
   pkill -f "node stockbot.js"
   
   # Check current IP
   curl https://httpbin.org/ip
   
   # Verify proxy status
   node proxy-cli.js status
   ```

2. **Investigation:**
   ```bash
   # Check logs for security events
   node proxy-cli.js logs | grep -i "security\|error\|leak"
   
   # Test proxy functionality
   node test-ip-leak.js
   ```

3. **Recovery:**
   ```bash
   # Recreate proxy pool
   node proxy-cli.js teardown-all
   node proxy-cli.js create 5
   
   # Restart with fresh proxies
   node stockbot.js <args>
   ```

### Proxy Compromise

If a proxy is suspected of being compromised:

```bash
# List all proxies
node proxy-cli.js list

# Teardown specific proxy
node proxy-cli.js teardown <service-name>

# Create replacement
node proxy-cli.js create 1
```

---

## 🔧 Advanced Security Configuration

### Custom IP Ranges

Modify the IP generation for specific requirements:

```javascript
// Custom IP range generation
generateCustomIP() {
  const customRanges = [
    () => `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`,
    () => `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`
  ];
  return customRanges[Math.floor(Math.random() * customRanges.length)]();
}
```

### Network-Level Restrictions

For enhanced security, consider iptables rules:

```bash
# Block direct connections (Linux only)
iptables -A OUTPUT -p tcp --dport 80 -j REJECT
iptables -A OUTPUT -p tcp --dport 443 -j REJECT

# Allow only SOCKS5 proxy connections
iptables -I OUTPUT -p tcp --dport 1080 -j ACCEPT
```

### AWS VPC Configuration

For maximum security, deploy proxies in custom VPC:

```javascript
// Custom VPC deployment (advanced)
const vpcConfig = {
  subnetType: 'public',
  assignPublicIp: 'ENABLED',
  securityGroups: ['sg-custom-stockbot']
};
```

---

## 📋 Security Checklist

### Initial Setup
- [ ] AWS credentials configured with minimal permissions
- [ ] Custom security group created (`stockbot-socks5-proxy-sg`)
- [ ] IP leak test passed (`node test-ip-leak.js`)
- [ ] WebRTC blocking verified
- [ ] Proxy health monitoring active

### Regular Maintenance
- [ ] Weekly proxy rotation completed
- [ ] Security logs reviewed
- [ ] IP leak tests passed
- [ ] Dead proxies cleaned up
- [ ] CloudWatch metrics reviewed

### Before Each Session
- [ ] Proxy status verified (`node proxy-cli.js status`)
- [ ] IP leak test passed
- [ ] Web dashboard accessible
- [ ] No direct IP connections detected

---

## 🔗 Security Resources

### Documentation
- [AWS Fargate Security Best Practices](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/security-fargate.html)
- [SOCKS5 Protocol Specification](https://tools.ietf.org/html/rfc1928)
- [Puppeteer Security Guidelines](https://pptr.dev/#?product=Puppeteer&version=main&show=outline)

### Testing Tools
- [HTTPBin IP Test](https://httpbin.org/ip)
- [Browser Leaks WebRTC Test](https://browserleaks.com/webrtc)
- [DNS Leak Test](https://dnsleaktest.com/)

### Monitoring
- AWS CloudWatch for proxy metrics
- Network monitoring tools (`netstat`, `wireshark`)
- Browser developer tools for connection analysis

---

## 📞 Security Support

For security-related issues:

1. **Check proxy status**: `node proxy-cli.js status`
2. **Run leak test**: `node test-ip-leak.js`
3. **Review logs**: `node proxy-cli.js logs`
4. **Verify web dashboard**: `http://localhost:3000/health`

Remember: **Security is layered**. No single measure is sufficient - the combination of all these protections ensures your real IP address remains hidden when using the StockBot system.

---

**🛡️ Security is our priority - Stay safe, stay anonymous!** 