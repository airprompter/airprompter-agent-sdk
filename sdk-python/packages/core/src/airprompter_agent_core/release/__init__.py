"""The seam between the packages: a verified release as a runtime consumes it, and a bundle the customer loads as one.

Example::

    from airprompter_agent_core.release.bundle_release import BundleRelease
    from airprompter_agent_core.release.reader import ReleaseReader

    reader: ReleaseReader = BundleRelease.load(bundle=bundle, root=pinned_root, scope=scope, now=now_iso)
    release = reader.current()   # a LoadedRelease: manifest, generation, payloads by content hash
"""
