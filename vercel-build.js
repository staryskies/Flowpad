#!/usr/bin/env node

// Vercel build script
console.log('🚀 Starting Vercel build...');

// Check if required files exist
const fs = require('fs');
const path = require('path');

const requiredFiles = [
  'server.js',
  'package.json',
  'index.html',
  'graph.html'
];

console.log('📁 Checking required files...');
requiredFiles.forEach(file => {
  if (fs.existsSync(file)) {
    console.log(`✅ ${file} exists`);
  } else {
    console.error(`❌ ${file} missing`);
    process.exit(1);
  }
});

// Check package.json
try {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  
  if (!packageJson.scripts.build) {
    console.error('❌ Build script missing from package.json');
    process.exit(1);
  }
  
  if (!packageJson.dependencies) {
    console.error('❌ Dependencies missing from package.json');
    process.exit(1);
  }
  
  console.log('✅ Package.json validation passed');
} catch (error) {
  console.error('❌ Invalid package.json:', error.message);
  process.exit(1);
}

console.log('🎉 Build validation completed successfully!');
console.log('📦 Ready for deployment'); 