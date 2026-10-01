export interface DigitalFootprintAnalysis {
  email: string;
  socialMediaAccounts: SocialMediaAccount[];
  servicesSubscribed: ServiceSubscription[];
  deviceFingerprint: DeviceFingerprint;
  networkActivity: NetworkActivity[];
  securityIndicators: SecurityIndicator[];
  recommendations: Recommendation[];
}

export interface SocialMediaAccount {
  platform: string;
  handle: string;
  profileUrl: string;
  followers?: number;
  following?: number;
  posts?: number;
  verified?: boolean;
  lastUpdated: Date;
}

export interface ServiceSubscription {
  serviceName: string;
  subscriptionDate: Date;
  status: 'active' | 'suspended' | 'terminated';
  lastChecked: Date;
}

export interface DeviceFingerprint {
  macAddress: string;
  ipAddress: string;
  deviceType: string;
  os: string;
  lastSeen: Date;
}

export interface NetworkActivity {
  sourceIp: string;
  destinationIp: string;
  port: number;
  protocol: string;
  timestamp: Date;
  activityType: string;
}

export interface SecurityIndicator {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: string[];
  timestamp: Date;
}

export interface Recommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  action: string;
  estimatedEffort: string;
}
