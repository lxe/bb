#!/usr/bin/env node

// AWS Beef Machine - Launch or connect to a powerful EC2 development instance
// Usage:
//   node aws-beef-machine.js          # Launch new instance or connect to existing
//   node aws-beef-machine.js --teardown   # Terminate instance and clean up resources

const { 
    EC2Client, 
    DescribeImagesCommand, 
    CreateSecurityGroupCommand, 
    AuthorizeSecurityGroupIngressCommand,
    CreateKeyPairCommand,
    RunInstancesCommand,
    DescribeInstancesCommand,
    DescribeSecurityGroupsCommand,
    TerminateInstancesCommand,
    DeleteSecurityGroupCommand,
    DeleteKeyPairCommand
} = require('@aws-sdk/client-ec2');
const { writeFileSync, chmodSync, existsSync, unlinkSync } = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const REGION = 'us-east-1';
const INSTANCE_TYPE = 'm5.2xlarge'; // 8 vCPUs, 32GB RAM, Up to 10 Gbps network
const KEY_NAME = 'beef-machine-key';
const SECURITY_GROUP_NAME = 'beef-machine-sg';

const ec2 = new EC2Client({ region: REGION });

async function findExistingInstance() {
    console.log('🔍 Checking for existing beef machine instances...');
    
    const command = new DescribeInstancesCommand({
        Filters: [
            { Name: 'tag:Name', Values: ['BeefMachine'] },
            { Name: 'tag:CreatedBy', Values: ['beef-machine-script'] },
            { Name: 'instance-state-name', Values: ['running', 'pending'] }
        ]
    });

    const response = await ec2.send(command);
    
    for (const reservation of response.Reservations || []) {
        for (const instance of reservation.Instances || []) {
            if (instance.State.Name === 'running' && instance.PublicIpAddress) {
                console.log(`✅ Found existing running instance: ${instance.InstanceId}`);
                console.log(`   Public IP: ${instance.PublicIpAddress}`);
                console.log(`   Instance Type: ${instance.InstanceType}`);
                return {
                    instanceId: instance.InstanceId,
                    publicIp: instance.PublicIpAddress,
                    privateIp: instance.PrivateIpAddress
                };
            } else if (instance.State.Name === 'pending') {
                console.log(`⏳ Found pending instance: ${instance.InstanceId}`);
                console.log('   Waiting for it to be ready...');
                const { publicIp, privateIp } = await waitForInstance(instance.InstanceId);
                return {
                    instanceId: instance.InstanceId,
                    publicIp,
                    privateIp
                };
            }
        }
    }
    
    console.log('ℹ️  No existing beef machine found');
    return null;
}

async function findLatestUbuntu24AMI() {
    console.log('🔍 Finding latest Ubuntu 24.04 LTS AMI...');
    
    const command = new DescribeImagesCommand({
        Filters: [
            { Name: 'name', Values: ['ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*'] },
            { Name: 'owner-id', Values: ['099720109477'] }, // Canonical
            { Name: 'state', Values: ['available'] },
            { Name: 'architecture', Values: ['x86_64'] },
            { Name: 'virtualization-type', Values: ['hvm'] }
        ],
        Owners: ['099720109477']
    });

    // Let's also try Ubuntu 24.04 (Noble Numbat)
    const ubuntu24Command = new DescribeImagesCommand({
        Filters: [
            { Name: 'name', Values: ['ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server-*'] },
            { Name: 'owner-id', Values: ['099720109477'] }, // Canonical
            { Name: 'state', Values: ['available'] },
            { Name: 'architecture', Values: ['x86_64'] },
            { Name: 'virtualization-type', Values: ['hvm'] }
        ],
        Owners: ['099720109477']
    });

    try {
        // Try Ubuntu 24.04 first
        const ubuntu24Response = await ec2.send(ubuntu24Command);
        if (ubuntu24Response.Images && ubuntu24Response.Images.length > 0) {
            const latestImage = ubuntu24Response.Images
                .sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate))[0];
            console.log(`✅ Found Ubuntu 24.04 AMI: ${latestImage.ImageId} - ${latestImage.Name}`);
            return latestImage.ImageId;
        }
    } catch (error) {
        console.log('⚠️  Ubuntu 24.04 not found, trying 22.04...');
    }

    // Fallback to Ubuntu 22.04
    const response = await ec2.send(command);
    if (!response.Images || response.Images.length === 0) {
        throw new Error('No Ubuntu AMIs found');
    }

    const latestImage = response.Images
        .sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate))[0];
    
    console.log(`✅ Found Ubuntu 22.04 AMI: ${latestImage.ImageId} - ${latestImage.Name}`);
    return latestImage.ImageId;
}

async function createSecurityGroup() {
    console.log('🔒 Setting up security group...');
    
    // Check if security group already exists
    try {
        const describeCommand = new DescribeSecurityGroupsCommand({
            GroupNames: [SECURITY_GROUP_NAME]
        });
        const response = await ec2.send(describeCommand);
        if (response.SecurityGroups && response.SecurityGroups.length > 0) {
            const sgId = response.SecurityGroups[0].GroupId;
            console.log(`✅ Using existing security group: ${sgId}`);
            return sgId;
        }
    } catch (error) {
        // Security group doesn't exist, create it
    }

    const createCommand = new CreateSecurityGroupCommand({
        GroupName: SECURITY_GROUP_NAME,
        Description: 'Security group for beef machine - SSH, HTTP, HTTPS access'
    });

    const response = await ec2.send(createCommand);
    const securityGroupId = response.GroupId;

    // Add rules for SSH, HTTP, HTTPS
    const authorizeCommand = new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: [
            {
                IpProtocol: 'tcp',
                FromPort: 22,
                ToPort: 22,
                IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'SSH access' }]
            },
            {
                IpProtocol: 'tcp',
                FromPort: 80,
                ToPort: 80,
                IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'HTTP access' }]
            },
            {
                IpProtocol: 'tcp',
                FromPort: 443,
                ToPort: 443,
                IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'HTTPS access' }]
            },
            {
                IpProtocol: 'tcp',
                FromPort: 3000,
                ToPort: 9000,
                IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Development ports' }]
            }
        ]
    });

    await ec2.send(authorizeCommand);
    console.log(`✅ Created security group: ${securityGroupId}`);
    return securityGroupId;
}

async function createKeyPair() {
    console.log('🔑 Creating SSH key pair...');
    
    const keyPath = path.join(__dirname, `${KEY_NAME}.pem`);
    
    if (existsSync(keyPath)) {
        console.log(`✅ Using existing key pair: ${keyPath}`);
        return KEY_NAME;
    }

    const command = new CreateKeyPairCommand({
        KeyName: KEY_NAME,
        KeyType: 'rsa',
        KeyFormat: 'pem'
    });

    try {
        const response = await ec2.send(command);
        writeFileSync(keyPath, response.KeyMaterial);
        chmodSync(keyPath, '400'); // Read-only for owner
        console.log(`✅ Created key pair: ${keyPath}`);
        return KEY_NAME;
    } catch (error) {
        if (error.name === 'InvalidKeyPair.Duplicate') {
            console.log(`✅ Key pair ${KEY_NAME} already exists in AWS`);
            return KEY_NAME;
        }
        throw error;
    }
}

async function launchInstance(amiId, securityGroupId, keyName) {
    console.log('🚀 Launching beefy EC2 instance...');
    console.log(`   Instance type: ${INSTANCE_TYPE} (8 vCPUs, 32GB RAM)`);
    console.log(`   AMI: ${amiId}`);
    console.log(`   Region: ${REGION}`);

    const command = new RunInstancesCommand({
        ImageId: amiId,
        MinCount: 1,
        MaxCount: 1,
        InstanceType: INSTANCE_TYPE,
        KeyName: keyName,
        SecurityGroupIds: [securityGroupId],
        BlockDeviceMappings: [
            {
                DeviceName: '/dev/sda1',
                Ebs: {
                    VolumeSize: 100, // 100GB SSD
                    VolumeType: 'gp3', // Latest generation SSD
                    Iops: 3000,
                    Throughput: 125,
                    DeleteOnTermination: true
                }
            }
        ],
        EbsOptimized: true,
        Monitoring: {
            Enabled: true
        },
        TagSpecifications: [
            {
                ResourceType: 'instance',
                Tags: [
                    { Key: 'Name', Value: 'BeefMachine' },
                    { Key: 'Purpose', Value: 'Development' },
                    { Key: 'CreatedBy', Value: 'beef-machine-script' }
                ]
            }
        ],
        UserData: Buffer.from(`#!/bin/bash
apt-get update
apt-get install -y htop curl wget git build-essential
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt-get install -y nodejs
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
usermod -aG docker ubuntu
# Install useful tools
apt-get install -y tree jq unzip zip
echo "🥩 Beef machine is ready!" > /home/ubuntu/welcome.txt
chown ubuntu:ubuntu /home/ubuntu/welcome.txt
`).toString('base64')
    });

    const response = await ec2.send(command);
    const instanceId = response.Instances[0].InstanceId;
    console.log(`✅ Instance launched: ${instanceId}`);
    
    return instanceId;
}

async function waitForInstance(instanceId) {
    console.log('⏳ Waiting for instance to be running and ready...');
    
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes max
    
    while (attempts < maxAttempts) {
        const command = new DescribeInstancesCommand({
            InstanceIds: [instanceId]
        });
        
        const response = await ec2.send(command);
        const instance = response.Reservations[0].Instances[0];
        
        if (instance.State.Name === 'running' && instance.PublicIpAddress) {
            console.log(`✅ Instance is running!`);
            console.log(`   Public IP: ${instance.PublicIpAddress}`);
            console.log(`   Private IP: ${instance.PrivateIpAddress}`);
            return {
                publicIp: instance.PublicIpAddress,
                privateIp: instance.PrivateIpAddress
            };
        }
        
        process.stdout.write('.');
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
    }
    
    throw new Error('Instance failed to start within 5 minutes');
}

async function connectSSH(publicIp, isExisting = false) {
    const keyPath = path.join(__dirname, `${KEY_NAME}.pem`);
    const sshCommand = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no ubuntu@${publicIp}`;
    
    console.log('\n🔗 SSH Connection Info:');
    console.log('='*50);
    console.log(`Command: ${sshCommand}`);
    console.log(`Key file: ${keyPath}`);
    console.log(`Public IP: ${publicIp}`);
    console.log('='*50);
    
    console.log('\n🚀 Connecting to your beef machine...');
    console.log('💡 The instance has been pre-configured with Node.js 20, Docker, and development tools');
    console.log('📁 Check /home/ubuntu/welcome.txt when you connect\n');
    
    // Only wait for SSH if this is a new instance
    if (!isExisting) {
        console.log('⏳ Waiting for SSH service to be ready...');
        await new Promise(resolve => setTimeout(resolve, 30000));
    }
    
    // Spawn SSH connection
    const ssh = spawn('ssh', [
        '-i', keyPath,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        `ubuntu@${publicIp}`
    ], {
        stdio: 'inherit'
    });
    
    ssh.on('close', (code) => {
        console.log(`\n👋 SSH session ended with code ${code}`);
        console.log(`🔗 To reconnect: ${sshCommand}`);
    });
}

async function teardownInstance() {
    console.log('💥 Tearing down beef machine...');
    
    // Find existing instances
    const command = new DescribeInstancesCommand({
        Filters: [
            { Name: 'tag:Name', Values: ['BeefMachine'] },
            { Name: 'tag:CreatedBy', Values: ['beef-machine-script'] },
            { Name: 'instance-state-name', Values: ['running', 'pending', 'stopping'] }
        ]
    });

    const response = await ec2.send(command);
    const instanceIds = [];
    
    for (const reservation of response.Reservations || []) {
        for (const instance of reservation.Instances || []) {
            instanceIds.push(instance.InstanceId);
            console.log(`🎯 Found instance to terminate: ${instance.InstanceId} (${instance.State.Name})`);
        }
    }

    if (instanceIds.length === 0) {
        console.log('ℹ️  No beef machine instances found to terminate');
        return;
    }

    // Terminate instances
    const terminateCommand = new TerminateInstancesCommand({
        InstanceIds: instanceIds
    });

    await ec2.send(terminateCommand);
    console.log(`✅ Terminated ${instanceIds.length} instance(s)`);

    // Wait for instances to terminate
    console.log('⏳ Waiting for instances to terminate...');
    let terminated = false;
    let attempts = 0;
    const maxAttempts = 60;

    while (!terminated && attempts < maxAttempts) {
        const checkCommand = new DescribeInstancesCommand({
            InstanceIds: instanceIds
        });
        
        const checkResponse = await ec2.send(checkCommand);
        let allTerminated = true;
        
        for (const reservation of checkResponse.Reservations || []) {
            for (const instance of reservation.Instances || []) {
                if (instance.State.Name !== 'terminated') {
                    allTerminated = false;
                    break;
                }
            }
        }
        
        if (allTerminated) {
            terminated = true;
            console.log('✅ All instances terminated');
        } else {
            process.stdout.write('.');
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }
    }

    // Clean up security group (optional - may fail if other resources are using it)
    try {
        const deleteSecurityGroupCommand = new DeleteSecurityGroupCommand({
            GroupName: SECURITY_GROUP_NAME
        });
        await ec2.send(deleteSecurityGroupCommand);
        console.log('✅ Deleted security group');
    } catch (error) {
        console.log('⚠️  Could not delete security group (may be in use by other resources)');
    }

    // Clean up key pair
    try {
        const deleteKeyPairCommand = new DeleteKeyPairCommand({
            KeyName: KEY_NAME
        });
        await ec2.send(deleteKeyPairCommand);
        console.log('✅ Deleted key pair from AWS');
        
        // Delete local key file
        const keyPath = path.join(__dirname, `${KEY_NAME}.pem`);
        if (existsSync(keyPath)) {
            unlinkSync(keyPath);
            console.log('✅ Deleted local key file');
        }
    } catch (error) {
        console.log('⚠️  Could not delete key pair:', error.message);
    }

    console.log('🎉 Teardown complete!');
}

async function main() {
    try {
        // Check for teardown flag
        if (process.argv.includes('--teardown')) {
            console.log('💥 AWS Beef Machine Teardown');
            console.log('='*40);
            await teardownInstance();
            return;
        }

        console.log('🥩 AWS Beef Machine Provisioner');
        console.log('='*40);
        
        // Check for existing instance first
        const existingInstance = await findExistingInstance();
        
        if (existingInstance) {
            console.log('\n🎉 Connecting to existing beef machine!');
            console.log(`Instance ID: ${existingInstance.instanceId}`);
            await connectSSH(existingInstance.publicIp, true);
            return;
        }
        
        console.log('\n🏗️  Creating new beef machine...');
        const amiId = await findLatestUbuntu24AMI();
        const securityGroupId = await createSecurityGroup();
        const keyName = await createKeyPair();
        const instanceId = await launchInstance(amiId, securityGroupId, keyName);
        const { publicIp, privateIp } = await waitForInstance(instanceId);
        
        console.log('\n🎉 Your beef machine is ready!');
        console.log(`Instance ID: ${instanceId}`);
        console.log(`Instance Type: ${INSTANCE_TYPE}`);
        console.log(`Specs: 8 vCPUs, 32GB RAM, 100GB SSD`);
        
        await connectSSH(publicIp);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
} 