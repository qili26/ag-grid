import classNames from 'classnames';
import React, { FunctionComponent, useState } from 'react';
import { Icon } from '../Icon';
import styles from '@design-system/modules/Collapsible.module.scss';

interface Props {
    title: string;
    versions: any[];
    fixVersion: string;
    onChange: (value: string) => any;
    children: any;
    hideExpander: boolean;
    isEmptyContent: boolean;
}

const Collapsible: FunctionComponent<Props> = ({ title, versions, fixVersion, onChange, children, hideExpander, isEmptyContent }) => {
    const [showNotes, setShowNotes] = useState(true);
    const [showMore, setShowMore] = useState(false);

    const collapsibleHandler = () => {
        setShowNotes((prevShowNotes) => !prevShowNotes);
    };

    const handleVersionLabelClick = (event: React.MouseEvent<HTMLLabelElement>) => {
        event.stopPropagation();
    };

    return (
        <div className={showNotes ? styles.isOpen : undefined}>
            <button className={classNames(styles.showHideButton, isEmptyContent ? styles.noHyperlink : '')} onClick={!isEmptyContent ? collapsibleHandler : undefined} disabled={isEmptyContent}>
                <div>
                    {title && !isEmptyContent && title}
                    {!hideExpander && (
                        <span className={classNames(styles.collapseIndicator, showNotes ? styles.isOpen : undefined)}>
                            <Icon name="chevronRight" />
                        </span>
                    )}
                </div>
                <div className={styles.selectContainer}>
                    <label className={styles.versionLabel} onClick={handleVersionLabelClick}>
                        Version:
                    </label>
                    <select
                        value={fixVersion || versions[0]}
                        aria-label={'Select Release Version'}
                        onChange={(event) => onChange(event.target.value)}
                        onClick={(event) => event.stopPropagation()} // Prevent event propagation
                    >
                        {versions &&
                            versions.map((version) => (
                                <option key={version} value={version}>
                                    {version}
                                </option>
                            ))}
                    </select>
                </div>
            </button>
            {showNotes && (
                <div
                    className={`${styles.content} ${showMore ? styles.contentExpanded : styles.contentCollapsed} ${
                        hideExpander ? styles.notExpandable : ''
                    } ${isEmptyContent ? styles.noContent : ''}`}
                >
                    <div>{children}</div>
                    {!hideExpander ? (
                        <a
                            className={styles.showMoreLink}
                            href="#"
                            onClick={(e) => {
                                e.preventDefault();
                                setShowMore(!showMore);
                            }}
                        >
                            {showMore ? 'Show less' : 'Show more'}
                            <span>
                                <Icon name={showMore ? 'chevronUp' : 'chevronDown'} />
                            </span>
                        </a>
                    ) : null}
                </div>
            )}
        </div>
    );
};

export default Collapsible;
