// Private trial fault controls only. Never consult the system Keychain.
const fs = require('node:fs'), path = require('node:path');
exports.createFakeKeychain = root => {
 const file=path.join(root,'fake-keychain.json'),hold=path.join(root,'keychain-hold');
 return {
  async get(key) {
   const deadline=Date.now()+10000;
   if(fs.existsSync(hold))fs.writeFileSync(path.join(root,'keychain-pending'),'pending',{mode:0o600});
   while(fs.existsSync(hold)) {
    if(Date.now()>=deadline)throw Error('Fake Keychain hold expired');
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   return fs.existsSync(file)?JSON.parse(fs.readFileSync(file))[key]??null:null;
  },
  async set(key,value) {const data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};data[key]=value;fs.writeFileSync(file,JSON.stringify(data),{mode:0o600});}
 };
};
