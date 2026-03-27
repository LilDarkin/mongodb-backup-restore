const { MongoClient } = require('mongodb');
const EJSON = require('bson').EJSON;
const fs = require('fs').promises;
const path = require('path');

class MongoBackupRestore {
  constructor(uri) {
    this.uri = uri;
    this.client = null;
  }

  async connect() {
    this.client = new MongoClient(this.uri);
    await this.client.connect();
    console.log('Connected to MongoDB');
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      console.log('Disconnected from MongoDB');
    }
  }

  async dump(outputDir, dbName = null) {
    try {
      await this.connect();
      await fs.mkdir(outputDir, { recursive: true });

      let userDatabases;
      if (dbName) {
        console.log(`Targeting specific database: ${dbName}`);
        userDatabases = [{ name: dbName }];
      } else {
        const admin = this.client.db().admin();
        const { databases } = await admin.listDatabases();
        // Filter out system databases
        userDatabases = databases.filter(
          db => !['admin', 'local', 'config'].includes(db.name)
        );
      }

      console.log(`Found ${userDatabases.length} database(s) to backup`);

      for (const dbInfo of userDatabases) {
        await this.dumpDatabase(dbInfo.name, outputDir);
      }

      // Save metadata
      const metadata = {
        backupDate: new Date().toISOString(),
        databases: userDatabases.map(db => db.name),
        version: await this.getServerVersion()
      };

      await fs.writeFile(
        path.join(outputDir, 'metadata.json'),
        EJSON.stringify(metadata, null, 2)
      );

      console.log('\nBackup completed successfully!');
      console.log(`Backup location: ${outputDir}`);
    } catch (error) {
      console.error('Backup failed:', error);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async dumpDatabase(dbName, outputDir) {
    console.log(`\nBacking up database: ${dbName}`);
    const db = this.client.db(dbName);
    const dbDir = path.join(outputDir, dbName);
    await fs.mkdir(dbDir, { recursive: true });

    const collections = await db.listCollections().toArray();
    console.log(`  Found ${collections.length} collection(s)`);

    for (const collInfo of collections) {
      await this.dumpCollection(db, collInfo.name, dbDir);
    }
  }

  async dumpCollection(db, collectionName, dbDir) {
    console.log(`  - Backing up collection: ${collectionName}`);
    const collection = db.collection(collectionName);
    const collDir = path.join(dbDir, collectionName);
    await fs.mkdir(collDir, { recursive: true });

    // Dump indexes
    const indexes = await collection.indexes();
    await fs.writeFile(
      path.join(collDir, 'indexes.json'),
      EJSON.stringify(indexes, null, 2)
    );

    // Dump collection options
    const collectionInfo = await db.listCollections(
      { name: collectionName }
    ).toArray();
    await fs.writeFile(
      path.join(collDir, 'metadata.json'),
      EJSON.stringify(collectionInfo[0], null, 2)
    );

    // Dump documents in batches
    const batchSize = 1000;
    let batch = 0;
    let cursor = collection.find({});
    let documents = [];

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      documents.push(doc);

      if (documents.length >= batchSize) {
        await this.writeBatch(collDir, batch, documents);
        batch++;
        documents = [];
      }
    }

    // Write remaining documents
    if (documents.length > 0) {
      await this.writeBatch(collDir, batch, documents);
    }

    console.log(`    Exported ${batch * batchSize + documents.length} document(s)`);
  }

  async writeBatch(collDir, batchNum, documents) {
    const filename = path.join(collDir, `data_${batchNum}.json`);
    // Use EJSON to preserve MongoDB types (ObjectId, Date, Binary, etc.)
    await fs.writeFile(filename, EJSON.stringify(documents, null, 2));
  }

  async restore(inputDir, options = {}) {
    const { dropExisting = false, dbName = null } = options;

    try {
      await this.connect();

      // Read metadata
      const metadataPath = path.join(inputDir, 'metadata.json');
      const metadataContent = await fs.readFile(metadataPath, 'utf8');
      const metadata = EJSON.parse(metadataContent);

      console.log(`Restoring backup from: ${metadata.backupDate}`);
      
      const databasesToRestore = dbName 
        ? metadata.databases.filter(name => name === dbName)
        : metadata.databases;

      if (dbName && databasesToRestore.length === 0) {
        console.log(`Warning: Database "${dbName}" not found in backup metadata`);
      }

      console.log(`Found ${databasesToRestore.length} database(s) to restore`);

      for (const db of databasesToRestore) {
        await this.restoreDatabase(db, inputDir, dropExisting);
      }

      console.log('\nRestore completed successfully!');
    } catch (error) {
      console.error('Restore failed:', error);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async restoreDatabase(dbName, inputDir, dropExisting) {
    console.log(`\nRestoring database: ${dbName}`);
    const db = this.client.db(dbName);
    const dbDir = path.join(inputDir, dbName);

    if (dropExisting) {
      console.log(`  Dropping existing database: ${dbName}`);
      await db.dropDatabase();
    }

    const collections = await fs.readdir(dbDir);

    for (const collectionName of collections) {
      const collPath = path.join(dbDir, collectionName);
      const stat = await fs.stat(collPath);
      
      if (stat.isDirectory()) {
        await this.restoreCollection(db, collectionName, collPath, dropExisting);
      }
    }
  }

  async restoreCollection(db, collectionName, collDir, dropExisting) {
    console.log(`  - Restoring collection: ${collectionName}`);

    // Read metadata to create collection with options
    const metadataPath = path.join(collDir, 'metadata.json');
    let collectionOptions = {};
    
    try {
      const metadataContent = await fs.readFile(metadataPath, 'utf8');
      const metadata = EJSON.parse(metadataContent);
      collectionOptions = metadata.options || {};
    } catch (error) {
      console.log(`    No metadata found, using default options`);
    }

    // Drop collection if it exists and dropExisting is true
    if (dropExisting) {
      try {
        await db.collection(collectionName).drop();
      } catch (error) {
        // Collection might not exist, ignore
      }
    }

    // Create collection with options
    try {
      await db.createCollection(collectionName, collectionOptions);
    } catch (error) {
      // Collection might already exist
    }

    const collection = db.collection(collectionName);

    // Restore documents
    const files = await fs.readdir(collDir);
    const dataFiles = files.filter(f => f.startsWith('data_') && f.endsWith('.json'));
    
    let totalDocs = 0;
    for (const file of dataFiles.sort()) {
      const filePath = path.join(collDir, file);
      const content = await fs.readFile(filePath, 'utf8');
      // Use EJSON to restore MongoDB types properly
      const documents = EJSON.parse(content);
      
      if (documents.length > 0) {
        await collection.insertMany(documents, { ordered: false });
        totalDocs += documents.length;
      }
    }

    console.log(`    Restored ${totalDocs} document(s)`);

    // Restore indexes (skip _id_ as it's created automatically)
    const indexesPath = path.join(collDir, 'indexes.json');
    try {
      const indexesContent = await fs.readFile(indexesPath, 'utf8');
      const indexes = EJSON.parse(indexesContent);
      
      for (const index of indexes) {
        if (index.name !== '_id_') {
          const { key, name, ...options } = index;
          try {
            await collection.createIndex(key, { name, ...options });
            console.log(`    Created index: ${name}`);
          } catch (error) {
            console.log(`    Warning: Could not create index ${name}: ${error.message}`);
          }
        }
      }
    } catch (error) {
      console.log(`    No indexes to restore or error reading indexes`);
    }
  }

  async getServerVersion() {
    const admin = this.client.db().admin();
    const info = await admin.serverInfo();
    return info.version;
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !['dump', 'restore'].includes(command)) {
    console.log('Usage:');
    console.log('  node script.js dump <mongodb-uri> <output-directory> [--db <db-name>]');
    console.log('  node script.js restore <mongodb-uri> <input-directory> [--db <db-name>] [--drop]');
    console.log('\nExamples:');
    console.log('  node script.js dump "mongodb://localhost:27017" ./backup');
    console.log('  node script.js dump "mongodb://localhost:27017" ./backup --db myDatabase');
    console.log('  node script.js restore "mongodb://localhost:27017" ./backup');
    console.log('  node script.js restore "mongodb://localhost:27017" ./backup --db myDatabase --drop');
    console.log('\nNote: Always wrap the MongoDB URI in quotes to prevent shell interpretation!');
    process.exit(1);
  }

  const uri = args[1];
  const directory = args[2];

  if (!uri || !directory) {
    console.error('Error: Missing required arguments');
    process.exit(1);
  }

  const dbIndex = args.indexOf('--db');
  const dbName = dbIndex !== -1 ? args[dbIndex + 1] : null;

  const backupRestore = new MongoBackupRestore(uri);

  try {
    if (command === 'dump') {
      await backupRestore.dump(directory, dbName);
    } else if (command === 'restore') {
      const dropExisting = args.includes('--drop');
      await backupRestore.restore(directory, { dropExisting, dbName });
    }
  } catch (error) {
    console.error('Operation failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = MongoBackupRestore;