const {
  ECSClient,
  CreateServiceCommand,
  DeleteServiceCommand,
  DescribeServicesCommand,
  CreateClusterCommand,
  DescribeTasksCommand,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  DescribeClustersCommand,
} = require('@aws-sdk/client-ecs');
const {
  EC2Client,
  DescribeRegionsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  DescribeVpcsCommand,
  DescribeNetworkInterfacesCommand,
} = require('@aws-sdk/client-ec2');
const { 
  CloudWatchLogsClient, 
  CreateLogGroupCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
  FilterLogEventsCommand 
} = require('@aws-sdk/client-cloudwatch-logs');
const { IAMClient, CreateRoleCommand, AttachRolePolicyCommand, GetRoleCommand } = require('@aws-sdk/client-iam');
const fs = require('fs').promises;
const path = require('path');

class ProxyManager {
  constructor() {
    this.activeProxies = [];
    this.stateFile = path.join(__dirname, 'proxies.json');
    this.regions = [
      // North America
      'us-east-1',      // N. Virginia
      'us-east-2',      // Ohio
      'us-west-1',      // N. California
      // 'us-west-2',      // Oregon - No default VPC
      'ca-central-1',   // Canada (Central)
      

      // These require me to click a button to override location in the browser, so TODO
      // Europe
      // 'eu-west-1',      // Ireland
      // 'eu-west-2',      // London
      // 'eu-west-3',      // Paris
      // 'eu-south-1',     // Milan
      // 'eu-south-2',     // Spain
      // 'eu-central-1',   // Frankfurt
      // 'eu-central-2',   // Zurich
      // 'eu-north-1',     // Stockholm
      
      // Oceania
      // 'ap-southeast-1', // Singapore
      // 'ap-southeast-2', // Sydney
      // 'ap-southeast-3', // Jakarta
      // 'ap-southeast-4', // Melbourne
    ];
    this.currentRegionIndex = 0;
    this.clusterName = 'stockbot-proxy-cluster';
    this.taskDefinitionFamily = 'stockbot-socks5-proxy';
    this.executionRoleArn = null;
    this.config = {
      socksPort: 1080,
      cpu: '256',
      memory: '512',
      containerImage: 'serjs/go-socks5-proxy:latest',
      securityGroupName: 'stockbot-socks5-proxy-sg',
      roleName: 'stockbot-ecs-execution-role',
    };
    
    // Concurrency control and caching  
    this.maxConcurrentOperations = 5; // Can be higher now that readiness checks are separate
    this.taskDefinitionCache = new Map(); // region -> taskDefinitionArn
    this.securityGroupCache = new Map(); // region -> securityGroupId
    this.taskDefinitionMutex = new Map(); // region -> Promise (to serialize task def creation)
    this.globalTaskDefinitionLock = null; // Global lock for task definition creation
    this.retryConfig = {
      maxRetries: 4, // Reasonable retries
      baseDelay: 1500, // Reasonable base delay
      maxDelay: 15000 // Reasonable max delay
    };
  }

  // ============ INITIALIZATION ============
  async init() {
    console.log('🔧 Initializing Proxy Manager...');
    await this.loadState();
    await this.validateActiveProxies();
    console.log(`✅ Proxy Manager initialized with ${this.activeProxies.length} active proxies`);
  }

  async loadState() {
    try {
      const data = await fs.readFile(this.stateFile, 'utf8');
      const state = JSON.parse(data);
      
      this.activeProxies = state.activeProxies.map(proxy => ({
        ...proxy,
        teardown: this.createTeardownFunction(proxy.region, proxy.serviceName)
      }));
      
      console.log(`📖 Loaded ${this.activeProxies.length} proxies from state file`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('📄 No existing proxy state file found, starting fresh');
      } else {
        console.warn('⚠️  Error loading proxy state:', error.message);
      }
      this.activeProxies = [];
    }
  }

  async saveState() {
    try {
      const state = {
        activeProxies: this.activeProxies.map(proxy => ({
          url: proxy.url,
          region: proxy.region,
          serviceName: proxy.serviceName,
          publicIp: proxy.publicIp,
          createdAt: proxy.createdAt || new Date().toISOString()
        })),
        lastUpdated: new Date().toISOString()
      };
      
      await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2));
      console.log(`💾 Saved proxy state to ${this.stateFile}`);
    } catch (error) {
      console.error('❌ Error saving proxy state:', error.message);
    }
  }

  // ============ VALIDATION ============
  async validateActiveProxies() {
    console.log('🔍 Validating active proxies...');
    const validProxies = [];
    
    const validationPromises = this.activeProxies.map(async (proxy) => {
      try {
        const ecsClient = this.getECSClient(proxy.region);
        const response = await ecsClient.send(new DescribeServicesCommand({
          cluster: this.clusterName,
          services: [proxy.serviceName]
        }));
        
        const service = response.services[0];
        if (service?.status === 'ACTIVE' && service.runningCount > 0) {
          console.log(`✅ Proxy ${proxy.serviceName} in ${proxy.region} is active`);
          return proxy;
        } else {
          console.log(`❌ Proxy ${proxy.serviceName} in ${proxy.region} is not active`);
          return null;
        }
      } catch (error) {
        console.log(`❌ Error validating proxy ${proxy.serviceName} in ${proxy.region}:`, error.message);
        return null;
      }
    });

    const results = await Promise.all(validationPromises);
    const newValidProxies = results.filter(proxy => proxy !== null);
    
    if (newValidProxies.length !== this.activeProxies.length) {
      this.activeProxies = newValidProxies;
      await this.saveState();
    }
  }

  // ============ AWS CLIENT HELPERS ============
  getECSClient(region) {
    return new ECSClient({ region });
  }

  getEC2Client(region) {
    return new EC2Client({ region });
  }

  getLogsClient(region) {
    return new CloudWatchLogsClient({ region });
  }

  getIAMClient() {
    return new IAMClient({ region: 'us-east-1' });
  }

  // ============ UTILITY METHODS ============
  getActiveProxies() {
    return this.activeProxies.slice();
  }

  getProxyCount() {
    return this.activeProxies.length;
  }

  getNextRegion() {
    const region = this.regions[this.currentRegionIndex];
    this.currentRegionIndex = (this.currentRegionIndex + 1) % this.regions.length;
    return region;
  }

  getRegionDistribution(targetRegions) {
    const distribution = {};
    targetRegions.forEach(region => {
      distribution[region] = (distribution[region] || 0) + 1;
    });
    
    return Object.entries(distribution)
      .map(([region, count]) => `${region}(${count})`)
      .join(', ');
  }

  async retryWithBackoff(operation, operationName, region = 'unknown') {
    let lastError;
    
    for (let attempt = 1; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        // Check for specific AWS errors that we should retry
        const shouldRetry = this.shouldRetryError(error);
        
        if (!shouldRetry || attempt === this.retryConfig.maxRetries) {
          throw error;
        }
        
        const delay = Math.min(
          this.retryConfig.baseDelay * Math.pow(2, attempt - 1),
          this.retryConfig.maxDelay
        );
        
        console.log(`⚠️  ${operationName} failed in ${region} (attempt ${attempt}/${this.retryConfig.maxRetries}): ${error.message}`);
        console.log(`🔄 Retrying in ${delay}ms...`);
        
        await this.delay(delay);
      }
    }
    
    throw lastError;
  }

  shouldRetryError(error) {
    const retryableErrors = [
      'Too many concurrent attempts',
      'Throttling',
      'RequestLimitExceeded',
      'ServiceUnavailable',
      'InternalError',
      'Rate exceeded'
    ];
    
    return retryableErrors.some(retryableError => 
      error.message?.includes(retryableError) || error.code?.includes(retryableError)
    );
  }

  createTeardownFunction(region, serviceName) {
    return async () => {
      try {
        const ecsClient = this.getECSClient(region);
        await ecsClient.send(new DeleteServiceCommand({
          cluster: this.clusterName,
          service: serviceName,
          force: true,
        }));
        console.log(`✅ Proxy service ${serviceName} in ${region} deleted`);
        
        this.activeProxies = this.activeProxies.filter(p => p.serviceName !== serviceName);
        await this.saveState();
      } catch (error) {
        console.warn(`⚠️  Error deleting proxy service ${serviceName} in ${region}:`, error.message);
      }
    };
  }

  // ============ IAM ROLE MANAGEMENT ============
  async ensureExecutionRole() {
    if (this.executionRoleArn) {
      return this.executionRoleArn;
    }

    const iamClient = this.getIAMClient();
    
    try {
      const response = await iamClient.send(new GetRoleCommand({ RoleName: this.config.roleName }));
      this.executionRoleArn = response.Role.Arn;
      console.log(`✅ Using existing execution role`);
      return this.executionRoleArn;
    } catch (error) {
      if (!this.isResourceNotFoundError(error)) {
        throw error;
      }
    }

    console.log('🔧 Creating ECS execution role...');
    return await this.createExecutionRole();
  }

  async createExecutionRole() {
    const iamClient = this.getIAMClient();
    const trustPolicy = {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'ecs-tasks.amazonaws.com' },
        Action: 'sts:AssumeRole',
      }],
    };

    const roleResponse = await iamClient.send(new CreateRoleCommand({
      RoleName: this.config.roleName,
      AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
      Description: 'Execution role for StockBot ECS tasks',
    }));

    await iamClient.send(new AttachRolePolicyCommand({
      RoleName: this.config.roleName,
      PolicyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
    }));

    this.executionRoleArn = roleResponse.Role.Arn;
    console.log(`✅ Created execution role`);

    // Wait for IAM propagation
    await this.delay(5000);
    return this.executionRoleArn;
  }

  // ============ INFRASTRUCTURE SETUP ============
  async ensureCluster(region) {
    const ecsClient = this.getECSClient(region);
    
    try {
      const response = await ecsClient.send(new DescribeClustersCommand({
        clusters: [this.clusterName],
      }));

      if (response.clusters.length === 0 || response.clusters[0].status !== 'ACTIVE') {
        console.log(`🔧 Creating ECS cluster in ${region}...`);
        await ecsClient.send(new CreateClusterCommand({
          clusterName: this.clusterName,
          capacityProviders: ['FARGATE'],
          defaultCapacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }],
        }));
        console.log(`✅ Created ECS cluster in ${region}`);
      }
    } catch (error) {
      console.error(`❌ Failed to ensure cluster in ${region}:`, error.message);
      throw error;
    }
  }

  async ensureLogGroup(region) {
    const logsClient = this.getLogsClient(region);
    
    try {
      await logsClient.send(new CreateLogGroupCommand({
        logGroupName: `/ecs/stockbot-proxy/${region}`,
      }));
    } catch (error) {
      if (error.name !== 'ResourceAlreadyExistsException') {
        console.warn(`⚠️  Failed to create log group in ${region}:`, error.message);
      }
    }
  }

  async getDefaultSubnet(region) {
    const ec2Client = this.getEC2Client(region);
    
    // Strategy 1: Look for default subnets
    const subnetQueries = [
      { Name: 'default-for-az', Values: ['true'] },
      { Name: 'map-public-ip-on-launch', Values: ['true'] },
      {} // All subnets as fallback
    ];

    for (const filters of subnetQueries) {
      try {
        const response = await ec2Client.send(new DescribeSubnetsCommand({
          Filters: Object.keys(filters).length ? [filters] : undefined
        }));
        
        if (response.Subnets?.length > 0) {
          // Prefer subnets that auto-assign public IPs
          const publicSubnet = response.Subnets.find(subnet => subnet.MapPublicIpOnLaunch);
          if (publicSubnet) {
            console.log(`✅ Found public subnet ${publicSubnet.SubnetId} in ${region}`);
            return publicSubnet.SubnetId;
          }
          
          // Otherwise use the first subnet
          console.log(`✅ Found subnet ${response.Subnets[0].SubnetId} in ${region}`);
          return response.Subnets[0].SubnetId;
        }
      } catch (error) {
        console.warn(`⚠️  Failed subnet query in ${region}:`, error.message);
      }
    }

    // Strategy 2: Try to find any VPC and use its first subnet
    try {
      console.warn(`⚠️  No default subnet found in ${region}, looking for any VPC...`);
      const vpcResponse = await ec2Client.send(new DescribeVpcsCommand({}));
      
      if (vpcResponse.Vpcs?.length > 0) {
        const vpcId = vpcResponse.Vpcs[0].VpcId;
        const subnetResponse = await ec2Client.send(new DescribeSubnetsCommand({
          Filters: [{ Name: 'vpc-id', Values: [vpcId] }]
        }));
        
        if (subnetResponse.Subnets?.length > 0) {
          console.log(`✅ Found fallback subnet ${subnetResponse.Subnets[0].SubnetId} in VPC ${vpcId} in ${region}`);
          return subnetResponse.Subnets[0].SubnetId;
        }
      }
    } catch (error) {
      console.warn(`⚠️  Failed to find fallback VPC/subnet in ${region}:`, error.message);
    }

    console.error(`❌ No usable subnet found in ${region}`);
    return null;
  }

  async ensureSecurityGroup(region) {
    // Check cache first
    if (this.securityGroupCache.has(region)) {
      return this.securityGroupCache.get(region);
    }
    
    const ec2Client = this.getEC2Client(region);
    
    // Check if security group exists
    const existingGroupId = await this.findExistingSecurityGroup(region);
    if (existingGroupId) {
      console.log(`✅ Using existing security group ${existingGroupId} in ${region}`);
      await this.updateSecurityGroupRules(region, existingGroupId);
      this.securityGroupCache.set(region, existingGroupId);
      return existingGroupId;
    }

    // Create new security group with retry
    const securityGroupId = await this.retryWithBackoff(
      () => this.createNewSecurityGroup(region),
      'Security group creation',
      region
    );
    
    this.securityGroupCache.set(region, securityGroupId);
    return securityGroupId;
  }

  async findExistingSecurityGroup(region) {
    const ec2Client = this.getEC2Client(region);
    
    try {
      const response = await ec2Client.send(new DescribeSecurityGroupsCommand({
        Filters: [{ Name: 'group-name', Values: [this.config.securityGroupName] }],
      }));

      return response.SecurityGroups?.[0]?.GroupId || null;
    } catch (error) {
      console.warn(`⚠️  Error checking existing security group in ${region}:`, error.message);
      return null;
    }
  }

  async updateSecurityGroupRules(region, securityGroupId) {
    const ec2Client = this.getEC2Client(region);
    
    try {
      const response = await ec2Client.send(new DescribeSecurityGroupsCommand({
        GroupIds: [securityGroupId],
      }));

      const securityGroup = response.SecurityGroups[0];
      const requiredRule = {
        IpProtocol: 'tcp',
        FromPort: this.config.socksPort,
        ToPort: this.config.socksPort,
        IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'SOCKS5 proxy access' }],
      };

      // Check if the required rule exists
      const hasRequiredRule = securityGroup.IpPermissions.some(permission => 
        permission.IpProtocol === requiredRule.IpProtocol &&
        permission.FromPort === requiredRule.FromPort &&
        permission.ToPort === requiredRule.ToPort &&
        permission.IpRanges.some(range => range.CidrIp === '0.0.0.0/0')
      );

      if (hasRequiredRule) {
        console.log(`✅ Security group ${securityGroupId} already has correct rules in ${region}`);
        return;
      }

      // Remove all existing TCP rules and add the required one
      const tcpRules = securityGroup.IpPermissions.filter(p => p.IpProtocol === 'tcp');
      
      if (tcpRules.length > 0) {
        console.log(`🔧 Updating security group rules in ${region}...`);
        await ec2Client.send(new RevokeSecurityGroupIngressCommand({
          GroupId: securityGroupId,
          IpPermissions: tcpRules,
        }));
      }

      await ec2Client.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: [requiredRule],
      }));

      console.log(`✅ Updated security group ${securityGroupId} rules in ${region}`);
    } catch (error) {
      console.warn(`⚠️  Error updating security group rules in ${region}:`, error.message);
    }
  }

  async createNewSecurityGroup(region) {
    const ec2Client = this.getEC2Client(region);
    
    // Strategy 1: Try to get default VPC
    let vpcId;
    try {
      const defaultVpcResponse = await ec2Client.send(new DescribeVpcsCommand({
        Filters: [{ Name: 'is-default', Values: ['true'] }],
      }));
      
      if (defaultVpcResponse.Vpcs?.length > 0) {
        vpcId = defaultVpcResponse.Vpcs[0].VpcId;
        console.log(`✅ Using default VPC ${vpcId} in ${region}`);
      }
    } catch (error) {
      console.warn(`⚠️  Failed to get default VPC in ${region}:`, error.message);
    }
    
    // Strategy 2: Use any available VPC
    if (!vpcId) {
      console.warn(`⚠️  No default VPC in ${region}, looking for any VPC...`);
      const anyVpcResponse = await ec2Client.send(new DescribeVpcsCommand({}));
      
      if (!anyVpcResponse.Vpcs?.length) {
        throw new Error(`No VPC found in ${region}. This region may not be properly set up.`);
      }
      
      vpcId = anyVpcResponse.Vpcs[0].VpcId;
      console.log(`✅ Using fallback VPC ${vpcId} in ${region}`);
    }
    
    try {
      console.log(`🔧 Creating new security group in ${region}...`);

      const createResponse = await ec2Client.send(new CreateSecurityGroupCommand({
        GroupName: this.config.securityGroupName,
        Description: 'Security group for StockBot SOCKS5 proxies',
        VpcId: vpcId,
      }));

      const securityGroupId = createResponse.GroupId;

      await ec2Client.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: [{
          IpProtocol: 'tcp',
          FromPort: this.config.socksPort,
          ToPort: this.config.socksPort,
          IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'SOCKS5 proxy access' }],
        }],
      }));

      console.log(`✅ Created security group ${securityGroupId} in ${region}`);
      return securityGroupId;
    } catch (error) {
      // Handle the specific case where security group already exists
      if (error.message?.includes('already exists')) {
        console.log(`🔄 Security group already exists in ${region}, finding existing one...`);
        const existingGroupId = await this.findExistingSecurityGroup(region);
        if (existingGroupId) {
          await this.updateSecurityGroupRules(region, existingGroupId);
          return existingGroupId;
        }
      }
      throw error;
    }
  }

  async createTaskDefinition(region) {
    // Check cache first
    if (this.taskDefinitionCache.has(region)) {
      return this.taskDefinitionCache.get(region);
    }

    // Use mutex to serialize task definition creation per region
    if (this.taskDefinitionMutex.has(region)) {
      // Wait for ongoing creation to complete
      await this.taskDefinitionMutex.get(region);
      // Check cache again after waiting
      if (this.taskDefinitionCache.has(region)) {
        return this.taskDefinitionCache.get(region);
      }
    }

    // Wait for any global lock to clear (prevents concurrent task def creation across regions)
    while (this.globalTaskDefinitionLock) {
      await this.globalTaskDefinitionLock;
    }

    // Create the mutex promise for this region and set global lock
    const creationPromise = this.createTaskDefinitionWithMutex(region);
    this.taskDefinitionMutex.set(region, creationPromise);
    this.globalTaskDefinitionLock = creationPromise;
    
    try {
      const taskDefinitionArn = await creationPromise;
      return taskDefinitionArn;
    } finally {
      // Clean up the mutexes
      this.taskDefinitionMutex.delete(region);
      if (this.globalTaskDefinitionLock === creationPromise) {
        this.globalTaskDefinitionLock = null;
      }
    }
  }

  async createTaskDefinitionWithMutex(region) {
    // Add a small random delay to spread out task definition creation
    const randomDelay = Math.floor(Math.random() * 500) + 200; // 0.2-0.7 seconds
    await this.delay(randomDelay);
    
    const taskDefinitionArn = await this.retryWithBackoff(
      () => this.createTaskDefinitionInternal(region),
      'Task definition creation',
      region
    );
    
    this.taskDefinitionCache.set(region, taskDefinitionArn);
    return taskDefinitionArn;
  }

  async createTaskDefinitionInternal(region) {
    const ecsClient = this.getECSClient(region);
    const executionRoleArn = await this.ensureExecutionRole();

    const taskDefinition = {
      family: this.taskDefinitionFamily,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: this.config.cpu,
      memory: this.config.memory,
      executionRoleArn,
      containerDefinitions: [{
        name: 'socks5-proxy',
        image: this.config.containerImage,
        essential: true,
        portMappings: [{ containerPort: this.config.socksPort, protocol: 'tcp' }],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': `/ecs/stockbot-proxy/${region}`,
            'awslogs-region': region,
            'awslogs-stream-prefix': 'ecs',
          },
        },
      }],
    };

    try {
      const response = await ecsClient.send(new RegisterTaskDefinitionCommand(taskDefinition));
      return response.taskDefinition.taskDefinitionArn;
    } catch (error) {
      console.error(`❌ Failed to create task definition in ${region}:`, error.message);
      throw error;
    }
  }

  // ============ INFRASTRUCTURE PRE-SETUP ============
  async preCreateInfrastructure(regions) {
    console.log('🏗️  Pre-creating execution role...');
    
    // Only pre-create the execution role (fast and prevents issues)
    await this.ensureExecutionRole();
    
    console.log('✅ Infrastructure pre-creation complete');
  }

  // ============ PROXY CREATION ============
  async createProxies(count = 1, regions = null) {
    const availableRegions = regions || this.regions;
    const actualCount = count;
    
    // Distribute proxies across regions (round-robin)
    const targetRegions = [];
    for (let i = 0; i < actualCount; i++) {
      const regionIndex = i % availableRegions.length;
      targetRegions.push(availableRegions[regionIndex]);
    }
    
    console.log(`🚀 Creating ${actualCount} SOCKS5 proxies distributed across ${availableRegions.length} regions...`);
    console.log(`📍 Region distribution: ${this.getRegionDistribution(targetRegions)}`);
    
    // Pre-create infrastructure for all unique regions
    const uniqueRegions = [...new Set(targetRegions)];
    await this.preCreateInfrastructure(uniqueRegions);

    // Phase 1: Create all services with concurrency control (fast AWS API calls)
    console.log('🏭 Phase 1: Creating services with concurrency control...');
    const serviceSpecs = [];
    const serviceErrors = [];
    
    for (let i = 0; i < actualCount; i += this.maxConcurrentOperations) {
      const batch = targetRegions.slice(i, i + this.maxConcurrentOperations);
      const batchPromises = batch.map((region, index) => 
        this.createServiceWithProgress(region, i + index + 1, actualCount)
      );

      try {
        const batchResults = await Promise.allSettled(batchPromises);
        
        batchResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            serviceSpecs.push(result.value);
          } else {
            const region = batch[index];
            const proxyNum = i + index + 1;
            console.log(`[${new Date().toLocaleTimeString()}] ❌ [Service ${proxyNum}/${actualCount}] Failed: ${result.reason.message}`);
            serviceErrors.push(result.reason);
          }
        });

        // Small delay between batches for API rate limiting
        if (i + this.maxConcurrentOperations < actualCount) {
          console.log(`⏳ Waiting 1 second before next service batch...`);
          await this.delay(1000);
        }
      } catch (error) {
        console.error('❌ Error in batch service creation:', error.message);
        serviceErrors.push(error);
      }
    }

    console.log(`✅ Phase 1 complete: ${serviceSpecs.length} services created, ${serviceErrors.length} failed`);

    // Phase 2: Wait for all services to be ready (no concurrency limits needed)
    console.log('⏳ Phase 2: Waiting for all services to be ready (unlimited concurrency)...');
    const readinessPromises = serviceSpecs.map((spec, index) => 
      this.waitForServiceReadiness(spec, index + 1, serviceSpecs.length)
    );

    const readinessResults = await Promise.allSettled(readinessPromises);
    const successfulProxies = [];
    const readinessErrors = [];

    readinessResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successfulProxies.push(result.value);
      } else {
        console.log(`❌ [Readiness ${index + 1}/${serviceSpecs.length}] Failed: ${result.reason.message}`);
        readinessErrors.push(result.reason);
      }
    });

    const totalErrors = serviceErrors.length + readinessErrors.length;
    if (totalErrors > 0) {
      console.warn(`⚠️  ${totalErrors} total creation(s) failed (${serviceErrors.length} service + ${readinessErrors.length} readiness)`);
    }

    console.log(`✅ Successfully created ${successfulProxies.length} proxies`);
    return successfulProxies;
  }

  async createServiceWithProgress(region, serviceNum, total) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] 🚀 [Service ${serviceNum}/${total}] Starting creation in ${region}`);
    
    try {
      const result = await this.createProxyService(region);
      const completedTimestamp = new Date().toLocaleTimeString();
      console.log(`[${completedTimestamp}] ✅ [Service ${serviceNum}/${total}] Created successfully in ${region}`);
      return result;
    } catch (error) {
      // Add more context for VPC-related errors
      if (error.message?.includes('VPC') || error.message?.includes('subnet')) {
        console.error(`❌ [Service ${serviceNum}/${total}] Region ${region} networking issue: ${error.message}`);
        console.log(`💡 Tip: Region ${region} may need VPC/subnet setup. Consider excluding this region.`);
      }
      throw error;
    }
  }

  async waitForServiceReadiness(serviceSpec, readinessNum, total) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ⏳ [Readiness ${readinessNum}/${total}] Waiting for ${serviceSpec.serviceName} in ${serviceSpec.region}`);
    
    try {
      const publicIp = await this.waitForTaskRunning(serviceSpec.region, serviceSpec.serviceName);

      if (!publicIp) {
        throw new Error(`Failed to get public IP for proxy in ${serviceSpec.region}`);
      }

      const proxyObject = {
        url: `socks5://${publicIp}:${this.config.socksPort}`,
        region: serviceSpec.region,
        serviceName: serviceSpec.serviceName,
        publicIp,
        createdAt: new Date().toISOString(),
        teardown: this.createTeardownFunction(serviceSpec.region, serviceSpec.serviceName),
      };

      this.activeProxies.push(proxyObject);
      await this.saveState();
      
      const completedTimestamp = new Date().toLocaleTimeString();
      console.log(`[${completedTimestamp}] ✅ [Readiness ${readinessNum}/${total}] Proxy ready at ${publicIp}:${this.config.socksPort} in ${serviceSpec.region}`);

      return proxyObject;
    } catch (error) {
      throw error;
    }
  }

  async createProxy(region = null) {
    const targetRegion = region || this.getNextRegion();
    return await this.createSingleProxy(targetRegion);
  }

  async createSingleProxy(region) {
    console.log(`🚀 Creating SOCKS5 proxy in region: ${region}`);

    try {
      // Step 1: Fast AWS API calls (these are rate-limited and should be in concurrency control)
      const proxySpec = await this.createProxyService(region);
      
      // Step 2: Wait for readiness (this is just polling, not rate-limited)
      const publicIp = await this.waitForTaskRunning(proxySpec.region, proxySpec.serviceName);

      if (!publicIp) {
        throw new Error(`Failed to get public IP for proxy in ${region}`);
      }

      const proxyObject = {
        url: `socks5://${publicIp}:${this.config.socksPort}`,
        region: proxySpec.region,
        serviceName: proxySpec.serviceName,
        publicIp,
        createdAt: new Date().toISOString(),
        teardown: this.createTeardownFunction(proxySpec.region, proxySpec.serviceName),
      };

      this.activeProxies.push(proxyObject);
      await this.saveState();
      console.log(`✅ SOCKS5 proxy ready at ${publicIp}:${this.config.socksPort} in ${region}`);

      return proxyObject;
    } catch (error) {
      console.error(`❌ Failed to create proxy in ${region}:`, error.message);
      throw error;
    }
  }

  async createProxyService(region) {
    // Setup infrastructure in parallel where possible
    await Promise.all([
      this.ensureLogGroup(region),
      this.ensureCluster(region),
    ]);

    const [taskDefinitionArn, subnetId, securityGroupId] = await Promise.all([
      this.createTaskDefinition(region),
      this.getDefaultSubnet(region),
      this.ensureSecurityGroup(region),
    ]);

    if (!subnetId || !securityGroupId) {
      throw new Error(`Failed to get networking info for ${region}`);
    }

    const serviceName = `${this.taskDefinitionFamily}-${region}-${Date.now()}`;
    const ecsClient = this.getECSClient(region);

    // Create service
    const serviceResponse = await ecsClient.send(new CreateServiceCommand({
      cluster: this.clusterName,
      serviceName,
      taskDefinition: taskDefinitionArn,
      desiredCount: 1,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: [subnetId],
          securityGroups: [securityGroupId],
          assignPublicIp: 'ENABLED',
        },
      },
    }));

    console.log(`✅ Service ${serviceName} created in ${region}, waiting for readiness...`);
    
    return {
      region,
      serviceName,
      taskDefinitionArn
    };
  }

  async waitForTaskRunning(region, serviceName, maxWaitTime = 300000) {
    const ecsClient = this.getECSClient(region);
    const startTime = Date.now();

    console.log(`⏳ Waiting for proxy task in ${region} to be ready...`);

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const tasksResponse = await ecsClient.send(new ListTasksCommand({
          cluster: this.clusterName,
          serviceName,
        }));

        if (tasksResponse.taskArns?.length > 0) {
          const taskDetailsResponse = await ecsClient.send(new DescribeTasksCommand({
            cluster: this.clusterName,
            tasks: tasksResponse.taskArns,
          }));

          for (const task of taskDetailsResponse.tasks) {
            if (task.lastStatus === 'RUNNING') {
              const publicIp = await this.extractPublicIpFromTask(region, task);
              if (publicIp) {
                return publicIp;
              }
            }
          }
        }

        await this.delay(10000);
      } catch (error) {
        console.warn(`⚠️  Error waiting for task in ${region}:`, error.message);
        await this.delay(10000);
      }
    }

    throw new Error(`Timeout waiting for proxy task in ${region} to be running`);
  }

  async extractPublicIpFromTask(region, task) {
    const networkInterfaces = task.attachments?.find(
      (att) => att.type === 'ElasticNetworkInterface'
    )?.details;

    if (!networkInterfaces) return null;

    const networkInterfaceId = networkInterfaces.find(
      (detail) => detail.name === 'networkInterfaceId'
    )?.value;

    if (!networkInterfaceId) return null;

    return await this.getTaskPublicIp(region, networkInterfaceId);
  }

  async getTaskPublicIp(region, networkInterfaceId) {
    const ec2Client = this.getEC2Client(region);

    try {
      const response = await ec2Client.send(new DescribeNetworkInterfacesCommand({
        NetworkInterfaceIds: [networkInterfaceId],
      }));

      return response.NetworkInterfaces?.[0]?.Association?.PublicIp || null;
    } catch (error) {
      console.warn(`⚠️  Failed to get public IP for network interface ${networkInterfaceId}:`, error.message);
      return null;
    }
  }

  // ============ TEARDOWN ============
  async teardownAll() {
    console.log('💥 Tearing down all AWS Fargate SOCKS5 proxies...');

    const promises = this.activeProxies.map((proxy) => proxy.teardown());
    await Promise.all(promises);

    this.activeProxies = [];
    await this.saveState();
    console.log('✅ All AWS Fargate SOCKS5 proxies torn down');
  }

  // ============ HELPER METHODS ============
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  isResourceNotFoundError(error) {
    return ['NoSuchEntity', 'NoSuchEntityException'].includes(error.name) ||
           error.message?.includes('cannot be found');
  }

  // Legacy method for compatibility
  async printRecentLogs(region = null, lines = 20) {
    console.log('📝 Log viewing not implemented in simplified version');
    console.log('💡 Use AWS Console or CLI to view logs at: /ecs/stockbot-proxy/{region}');
  }
}

module.exports = { ProxyManager };
