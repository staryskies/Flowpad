#!/usr/bin/env node

/**
 * Simple API test script for Flowpad
 * Run with: node test-api.js
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function testAPI() {
  console.log('🧪 Testing Flowpad API endpoints...\n');
  
  try {
    // Test health endpoint
    console.log('1. Testing health endpoint...');
    const healthResponse = await fetch(`${BASE_URL}/api/health`);
    const healthData = await healthResponse.json();
    console.log(`   ✅ Health: ${healthData.status} (DB: ${healthData.database})\n`);
    
    // Test checklist endpoint
    console.log('2. Testing checklist endpoint...');
    const checklistResponse = await fetch(`${BASE_URL}/api/checklist`);
    const checklistData = await checklistResponse.json();
    console.log(`   ✅ Environment check:`);
    console.log(`      - DATABASE_URL: ${checklistData.env.DATABASE_URL_present ? '✅' : '❌'}`);
    console.log(`      - GOOGLE_CLIENT_ID: ${checklistData.env.GOOGLE_CLIENT_ID_present ? '✅' : '❌'}`);
    console.log(`      - JWT_SECRET: ${checklistData.env.JWT_SECRET_present ? '✅' : '❌'}`);
    console.log(`      - DB Connection: ${checklistData.database.connection_ok ? '✅' : '❌'}\n`);
    
    // Test static routes
    console.log('3. Testing static routes...');
    const routes = ['/', '/graph', '/privacy', '/terms'];
    for (const route of routes) {
      const response = await fetch(`${BASE_URL}${route}`);
      console.log(`   ${response.ok ? '✅' : '❌'} ${route} (${response.status})`);
    }
    console.log();
    
    // Test protected endpoints (should fail without auth)
    console.log('4. Testing protected endpoints (should return 401)...');
    const protectedEndpoints = [
      '/api/graphs',
      '/api/user/profile',
      '/api/graphs/inbox'
    ];
    
    for (const endpoint of protectedEndpoints) {
      const response = await fetch(`${BASE_URL}${endpoint}`);
      console.log(`   ${response.status === 401 ? '✅' : '❌'} ${endpoint} (${response.status})`);
    }
    console.log();
    
    console.log('🎉 API test completed successfully!');
    console.log('\n📝 Next steps:');
    console.log('   1. Set up Google OAuth credentials');
    console.log('   2. Configure database connection');
    console.log('   3. Test authentication flow');
    console.log('   4. Create and manage graphs');
    
  } catch (error) {
    console.error('❌ API test failed:', error.message);
    process.exit(1);
  }
}

// Run the test
testAPI();
