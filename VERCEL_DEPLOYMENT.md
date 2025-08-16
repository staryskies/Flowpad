# Vercel Deployment Guide

## 🚨 **Auto-Deploy Issues Fixed**

The following changes have been made to fix Vercel auto-deployment:

### 1. **Package.json Updates**
- Added `build` script (required by Vercel)
- Added `vercel-build` script (Vercel-specific)
- Ensured all dependencies are properly listed

### 2. **Vercel.json Configuration**
- Updated to use `@vercel/node@18` for proper Node.js version
- Added function timeout configuration
- Fixed routing configuration

### 3. **Environment Variables**
- Added proper environment variable handling
- Created `env.example` file for reference

## 🔧 **Vercel Dashboard Setup**

### **Step 1: Set Environment Variables**
In your Vercel dashboard, go to **Settings > Environment Variables** and add:

```
DATABASE_URL=postgresql://flowpad_user:MAOwGkTa8Et6OqgPGgiv8VLrBFX1vBqE@dpg-d2gb69vdiees73dauq4g-a/flowpad
GOOGLE_CLIENT_ID=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
JWT_SECRET=your-super-secret-jwt-key-here
NODE_ENV=production
```

### **Step 2: Build Settings**
Ensure these settings in Vercel:
- **Framework Preset**: Other
- **Build Command**: `npm run build`
- **Output Directory**: `.`
- **Install Command**: `npm install`

### **Step 3: Function Configuration**
- **Node.js Version**: 18.x
- **Function Timeout**: 30 seconds

## 🚀 **Deployment Commands**

### **Local Vercel CLI**
```bash
# Install Vercel CLI
npm i -g vercel

# Login to Vercel
vercel login

# Deploy
vercel

# Deploy to production
vercel --prod
```

### **GitHub Integration**
1. Connect your GitHub repository to Vercel
2. Enable auto-deploy on push to main branch
3. Ensure environment variables are set in Vercel dashboard

## 🔍 **Troubleshooting Auto-Deploy**

### **Common Issues & Solutions**

1. **Build Fails**
   - Check that `package.json` has `build` script
   - Ensure all dependencies are in `dependencies` (not `devDependencies`)
   - Verify Node.js version compatibility

2. **Environment Variables Missing**
   - Set all required env vars in Vercel dashboard
   - Check that `DATABASE_URL` is accessible
   - Verify Google OAuth credentials

3. **Function Timeout**
   - Database connection might be slow
   - Increase timeout in `vercel.json`
   - Check PostgreSQL connection

4. **CORS Issues**
   - Ensure your domain is added to Google OAuth authorized origins
   - Check CORS configuration in server.js

### **Debug Steps**
1. Check Vercel build logs for errors
2. Verify environment variables are set
3. Test database connection locally
4. Check Google OAuth configuration

## 📋 **Pre-Deployment Checklist**

- [ ] All environment variables set in Vercel
- [ ] Database is accessible from Vercel's servers
- [ ] Google OAuth credentials are valid
- [ ] Build script exists in package.json
- [ ] All dependencies are in dependencies (not devDependencies)
- [ ] Node.js version is compatible (18+)

## 🎯 **Post-Deployment**

After successful deployment:
1. Test the application endpoints
2. Verify Google OAuth works
3. Test database connections
4. Check that graphs can be created/saved
5. Test sharing functionality

## 📞 **Support**

If auto-deploy still fails:
1. Check Vercel build logs
2. Verify all environment variables
3. Test database connectivity
4. Check Google OAuth configuration
5. Review Vercel function logs 