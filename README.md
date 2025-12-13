# MongoDB Backup & Restore Tool

A robust Node.js utility for backing up and restoring MongoDB databases. This tool handles data, indexes, and metadata, ensuring a complete migration or backup solution. It uses EJSON to preserve rich MongoDB data types (like ObjectId, Date, Binary) during the export/import process.

## Features

- **Full Database Backup**: Automatically discovers and backs up all user databases (skipping system databases like `admin`, `local`, `config`).
- **Collection & Index Support**: Backs up documents, collection metadata (options), and indexes.
- **Data Type Preservation**: Uses `bson`'s EJSON to strictly preserve MongoDB data types in the JSON output.
- **Batch Processing**: Handles large collections efficiently by processing documents in batches.
- **Restore Options**: 
  - Restores data, indexes, and collection options.
  - Optional `--drop` flag to clear existing databases/collections before restoration.

## Prerequisites

- **Node.js**: Ensure you have Node.js installed (v12+ recommended).
- **MongoDB**: A running MongoDB instance (local or remote).

## Installation

1.  **Clone the repository** (or download the files).

2.  **Install dependencies**:
    ```bash
    npm install
    ```
    
    *Note: This project relies on `mongodb` and `bson` packages.*

## Usage

The script is executed via the command line using `node script.js`.

### 1. Backup (Dump)

Exports databases from a MongoDB instance to a local directory.

**Syntax:**
```bash
node script.js dump <mongodb-uri> <output-directory>
```

**Example:**
```bash
# Backup local MongoDB to ./my-backups folder
node script.js dump "mongodb://localhost:27017" ./my-backups
```

**Output Structure:**
The tool creates a directory structure like this:
```text
output-directory/
├── metadata.json           # Global backup metadata (version, date, db list)
├── database_name/
│   ├── collection_name/
│   │   ├── metadata.json   # Collection options
│   │   ├── indexes.json    # Index definitions
│   │   ├── data_0.json     # Data batch 1
│   │   └── data_1.json     # Data batch 2
```

### 2. Restore

Restores databases from a backup directory to a MongoDB instance.

**Syntax:**
```bash
node script.js restore <mongodb-uri> <input-directory> [--drop]
```

**Options:**
- `--drop`: (Optional) Drops the existing database or collection before restoring. Use with caution!

**Examples:**

```bash
# Restore from ./my-backups to local MongoDB
node script.js restore "mongodb://localhost:27017" ./my-backups

# Restore and overwrite existing data (DROP existing DBs)
node script.js restore "mongodb://localhost:27017" ./my-backups --drop
```

## Important Notes

- **URI Quoting**: Always wrap your MongoDB Connection URI in quotes (e.g., `"mongodb://..."`) to prevent your shell from interpreting special characters (like `&` or `?`).
- **Permissions**: Ensure the MongoDB user provided in the URI has sufficient privileges to read (for dump) and write/create databases (for restore).
