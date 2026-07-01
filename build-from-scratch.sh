#! /bin/bash

cd electron-forge-maker-msix
npm run build
cd ..
npm install
rm -rf out
npm run make