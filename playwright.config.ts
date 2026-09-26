import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./e2e',testMatch:'**/*.e2e.ts',fullyParallel:false,workers:1,
  use:{baseURL:process.env.E2E_BASE_URL||'http://localhost:5173',headless:true,launchOptions:process.env.PW_EXECUTABLE_PATH?{executablePath:process.env.PW_EXECUTABLE_PATH,args:['--no-sandbox','--no-zygote','--disable-dev-shm-usage']}:undefined,trace:'retain-on-failure'},
  reporter:[['list']],
});
