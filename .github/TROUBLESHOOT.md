# TROUBLESHOOT

## Development

### Limit of file watchers reached

Error: ENOSPC: System limit for number of file watchers reached
[Stackoverflow answer](https://stackoverflow.com/questions/55763428/react-native-error-enospc-system-limit-for-number-of-file-watchers-reached)

```bash
# insert the new value into the system config
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p

# check that the new value was applied
cat /proc/sys/fs/inotify/max_user_watches

# config variable name (not runnable)
fs.inotify.max_user_watches=524288
```

### EsLint shows error in GitHub Actions

```
Sometimes the hidden local errors are caused by the EsLint cache.
To fix this, you can delete the cache file and run the EsLint again.
```

## To test the upload component in the example folder

### Aws (localstack)

You need to install the [awscli-local](https://github.com/localstack/awscli-local).

```bash
pip install awscli-local
```

To create a bucket in localstack, you can use the following command:

```bash
awslocal s3 mb s3://upload
```

### Google Cloud Storage

Currently, the Google Cloud Storage resumable is not supported in [fake-gcs](https://github.com/fsouza/fake-gcs-server/issues/623).

You can use the [Google Storage](https://cloud.google.com/storage) to test the upload component.

### Azure Blob Storage

You need to install the [Azure Storage Explorer](https://azure.microsoft.com/en-gb/products/storage/storage-explorer/)

After the installation, you can create a new storage.
You need, to connect, with the emulator account and create a new container.

You should see the following screen:

![azure-storage-explorer-screen.png](.github%2Fassets%2Fazure-storage-explorer-screen.png)

Go to the "(Emulator - Default Ports) (Key)" -> "Blob Containers" and create with right-click a new "upload" container.
