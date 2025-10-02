// preprocessData.js
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Ensure you place your Excel files in the 'data' folder
const doctorsFile = path.join(__dirname, 'data', 'ŞUBE DOKTOR.xlsx');
const treatmentsFile = path.join(__dirname, 'data', 'TEDAVİLER.xlsx');
const outputFile = path.join(__dirname, 'knowledgebase.txt');

let knowledgeBaseContent = "Information about our clinics and treatments:\n\n";

const processFile = (filePath) => {
    try {
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0]; // Get first sheet
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);
        
        data.forEach(row => {
            let rowContent = Object.values(row)
                                 .filter(val => val && val.toString().trim() !== '' && !val.toString().includes('KAPALI'))
                                 .join('. ');
            if (rowContent) {
                knowledgeBaseContent += rowContent + "\n\n";
            }
        });
    } catch (error) {
        throw new Error(`Error processing file ${filePath}: ${error.message}`);
    }
};

function buildKnowledgeBase() {
    try {
        console.log('Processing files...');
        processFile(doctorsFile);
        processFile(treatmentsFile);
        fs.writeFileSync(outputFile, knowledgeBaseContent);
        console.log(`Knowledge base successfully created at ${outputFile}`);
    } catch (error) {
        console.error('Error building knowledge base:', error);
    }
}

buildKnowledgeBase()
